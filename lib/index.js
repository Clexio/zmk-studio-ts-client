import { Request, Response, RequestResponse, Notification } from './studio';
import { get_encoder, get_decoder } from './framing';
export { Request, RequestResponse, Response, Notification };
const RPC_TIMEOUT_MS = 5000;
const pendingByConnection = new WeakMap();
function reject_all_pending(pending, reason) {
    for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(reason);
    }
    pending.clear();
}
async function pump_responses(stream, pending) {
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done || !value) {
                reject_all_pending(pending, 'No response');
                break;
            }
            const entry = pending.get(value.requestId);
            if (!entry) {
                continue;
            }
            clearTimeout(entry.timer);
            pending.delete(value.requestId);
            if (value.meta?.noResponse) {
                entry.reject(new NoResponseError());
            }
            else if (value.meta?.simpleError) {
                entry.reject(new MetaError(value.meta.simpleError));
            }
            else {
                entry.resolve(value);
            }
        }
    }
    catch (e) {
        console.error("RPC response pump failed", e);
        reject_all_pending(pending, e);
    }
    finally {
        reader.releaseLock();
    }
}
export function create_rpc_connection(transport, opts) {
    let { writable: request_writable, readable: byte_readable } = new TransformStream({
        transform(chunk, controller) {
            let bytes = Request.encode(chunk).finish();
            controller.enqueue(bytes);
        },
    });
    let reqPipelineClosed = byte_readable
        .pipeThrough(new TransformStream(get_encoder()), { signal: opts?.signal })
        .pipeTo(transport.writable, { signal: opts?.signal });
    reqPipelineClosed.catch((r) => { console.log("Closed error", r); return r; }).then(async (reason) => {
        await byte_readable.cancel();
        transport.abortController.abort(reason);
    });
    let response_readable = transport.readable
        .pipeThrough(new TransformStream(get_decoder()), { signal: opts?.signal })
        .pipeThrough(new TransformStream({
        transform(chunk, controller) {
            try {
                controller.enqueue(Response.decode(chunk));
            }
            catch (e) {
                console.error("Failed to decode RPC response frame, skipping", e);
            }
        },
    }), { signal: opts?.signal });
    let [a, b] = response_readable.tee();
    let request_response_readable = a.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (chunk.requestResponse) {
                controller.enqueue(chunk.requestResponse);
            }
        },
    }), { signal: opts?.signal });
    let notification_readable = b.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (chunk.notification) {
                controller.enqueue(chunk.notification);
            }
        },
    }), { signal: opts?.signal });
    const connection = {
        label: transport.label,
        request_response_readable,
        request_writable,
        notification_readable,
        current_request: 0,
    };
    const pending = new Map();
    pendingByConnection.set(connection, pending);
    pump_responses(request_response_readable, pending);
    return connection;
}
export class NoResponseError extends Error {
    constructor() {
        super("No RPC response received");
        Object.setPrototypeOf(this, NoResponseError.prototype);
    }
}
export class MetaError extends Error {
    condition;
    constructor(condition) {
        super("Meta error: " + condition);
        this.condition = condition;
        Object.setPrototypeOf(this, MetaError.prototype);
    }
}
export class RpcTimeoutError extends Error {
    constructor(message = "RPC timeout") {
        super(message);
        Object.setPrototypeOf(this, RpcTimeoutError.prototype);
    }
}
export async function call_rpc(conn, req) {
    const pending = pendingByConnection.get(conn);
    if (!pending) {
        throw new Error("Invalid RPC connection");
    }
    const request = { ...req, requestId: conn.current_request++ };
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(request.requestId);
            reject(new RpcTimeoutError());
        }, RPC_TIMEOUT_MS);
        pending.set(request.requestId, { resolve, reject, timer });
        (async () => {
            const writer = conn.request_writable.getWriter();
            try {
                await Promise.race([
                    writer.write(request),
                    new Promise((_resolve, rejectWrite) => setTimeout(() => rejectWrite(new RpcTimeoutError("write timeout")), RPC_TIMEOUT_MS)),
                ]);
                writer.releaseLock();
            }
            catch (e) {
                try {
                    writer.releaseLock();
                }
                catch {
                    // 写入可能仍挂起，释放失败说明连接已不可用，交给断线/重连处理
                }
                clearTimeout(timer);
                pending.delete(request.requestId);
                reject(e);
            }
        })();
    });
}
