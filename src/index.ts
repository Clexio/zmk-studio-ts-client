import { Request, Response, RequestResponse, Notification } from './studio';

import { get_encoder, get_decoder } from './framing';
import { RpcTransport } from './transport';

import { Mutex } from 'async-mutex';
import { ErrorConditions } from './meta';
export { Request, RequestResponse, Response, Notification };

export interface RpcConnection {
  label: string;
  request_response_readable: ReadableStream<RequestResponse>;
  request_writable: WritableStream<Request>;
  notification_readable: ReadableStream<Notification>;
  current_request: number;
}

export interface CreateRpcConnectionOpts {
  signal?: AbortSignal;
}

interface PendingRequest {
  resolve: (value: RequestResponse) => void;
  reject: (reason?: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 5000;

// 每个连接独立的“等待响应”表：响应按 requestId 匹配，
// 超时后迟到的响应直接丢弃，不再因为一次丢包把整条 RPC 链路卡死。
const pendingByConnection = new WeakMap<RpcConnection, Map<number, PendingRequest>>();

function reject_all_pending(
  pending: Map<number, PendingRequest>,
  reason: any
) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(reason);
  }
  pending.clear();
}

async function pump_responses(
  stream: ReadableStream<RequestResponse>,
  pending: Map<number, PendingRequest>
) {
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
        // 已超时或被调用方放弃的响应：丢弃，避免污染下一次调用
        continue;
      }

      clearTimeout(entry.timer);
      pending.delete(value.requestId);
      if (value.meta?.noResponse) {
        entry.reject(new NoResponseError());
      } else if (value.meta?.simpleError) {
        entry.reject(new MetaError(value.meta.simpleError));
      } else {
        entry.resolve(value);
      }
    }
  } catch (e) {
    reject_all_pending(pending, e);
  } finally {
    reader.releaseLock();
  }
}

export function create_rpc_connection(transport: RpcTransport, opts?: CreateRpcConnectionOpts): RpcConnection {
  let { writable: request_writable, readable: byte_readable } =
    new TransformStream<Request, Uint8Array>({
      transform(chunk, controller) {
        let bytes = Request.encode(chunk).finish();
        controller.enqueue(bytes);
      },
    });

  let reqPipelineClosed = byte_readable
    .pipeThrough(new TransformStream(get_encoder()), { signal: opts?.signal })
    .pipeTo(transport.writable, { signal: opts?.signal });

  reqPipelineClosed.catch((r) => {console.log("Closed error", r); return r}).then(async (reason: any) => {
    await byte_readable.cancel();
    transport.abortController.abort(reason);
  });

  let response_readable = transport.readable
    .pipeThrough(new TransformStream(get_decoder()), { signal: opts?.signal })
    .pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(Response.decode(chunk));
        },
      }),
      { signal: opts?.signal }
    );

  let [a, b] = response_readable.tee();

  let request_response_readable = a.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (chunk.requestResponse) {
          controller.enqueue(chunk.requestResponse);
        }
      },
    }),
    { signal: opts?.signal }
  );

  let notification_readable = b.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (chunk.notification) {
          controller.enqueue(chunk.notification);
        }
      },
    }),
    { signal: opts?.signal }
  );

  const connection: RpcConnection = {
    label: transport.label,
    request_response_readable,
    request_writable,
    notification_readable,
    current_request: 0,
  };

  // 启动响应分发泵：从此只按 requestId 投递，reader.read() 不再阻塞后续调用
  const pending = new Map<number, PendingRequest>();
  pendingByConnection.set(connection, pending);
  pump_responses(request_response_readable, pending);

  return connection;
}

const rpcMutex = new Mutex();

export class NoResponseError extends Error {
  constructor() {
    super("No RPC response received");
    Object.setPrototypeOf(this, NoResponseError.prototype);
  }
}

export class MetaError extends Error {
  readonly condition: ErrorConditions;

  constructor(condition: ErrorConditions) {
    super("Meta error: " + condition);
    this.condition = condition;
    Object.setPrototypeOf(this, MetaError.prototype);
  }
}

export class RpcTimeoutError extends Error {
  constructor() {
    super("RPC timeout");
    Object.setPrototypeOf(this, RpcTimeoutError.prototype);
  }
}

export async function call_rpc(
  conn: RpcConnection,
  req: Omit<Request, 'requestId'>
): Promise<RequestResponse> {
  const pending = pendingByConnection.get(conn);
  if (!pending) {
    throw new Error("Invalid RPC connection");
  }

  const request: Request = { ...req, requestId: conn.current_request++ };

  return await new Promise<RequestResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.requestId);
      reject(new RpcTimeoutError());
    }, RPC_TIMEOUT_MS);

    // 先登记等待项再发送，避免“响应先到、等待表还没建好”的竞态
    pending.set(request.requestId, { resolve, reject, timer });

    rpcMutex
      .runExclusive(async () => {
        const writer = conn.request_writable.getWriter();
        try {
          await writer.write(request);
        } finally {
          writer.releaseLock();
        }
      })
      .catch((e) => {
        clearTimeout(timer);
        pending.delete(request.requestId);
        reject(e);
      });
  });
}
