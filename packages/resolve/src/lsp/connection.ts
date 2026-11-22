// REAL. JSON-RPC 2.0 over one language-server subprocess. Never throws and never rejects: a request
// settles as an outcome, and a server that exits or closes settles every pending request as `closed`.
import type { SubprocessHandle } from '../contract';
import { createFrameDecoder, encodeMessage } from './framing';

export type RpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: number | 'closed'; readonly message: string };

export interface LspConnectionOptions {
  /** Answers a request the SERVER sends. Default: `workspace/configuration` gets `{}` per item, else null. */
  readonly onServerRequest?: (method: string, params: unknown) => unknown;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** A frame that was not a JSON-RPC message. The connection keeps reading. */
  readonly onMalformed?: (reason: string) => void;
}

export interface LspConnection {
  request(method: string, params?: unknown): Promise<RpcOutcome>;
  notify(method: string, params?: unknown): void;
  /** Settles every pending request as closed and kills the process. Idempotent. */
  close(): void;
  readonly closed: boolean;
}

type Incoming =
  | { readonly kind: 'response'; readonly id: number; readonly outcome: RpcOutcome }
  | {
      readonly kind: 'request';
      readonly id: number | string;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The boundary: an untyped frame becomes one of three message kinds, or undefined. */
function classify(message: unknown): Incoming | undefined {
  if (!isRecord(message) || message['jsonrpc'] !== '2.0') return undefined;
  const { id, method, params, error } = message;
  if (typeof method === 'string') {
    if (typeof id === 'number' || typeof id === 'string')
      return { kind: 'request', id, method, params };
    return id === undefined ? { kind: 'notification', method, params } : undefined;
  }
  if (typeof id !== 'number') return undefined;
  if (isRecord(error)) {
    const code = typeof error['code'] === 'number' ? error['code'] : -32603;
    return {
      kind: 'response',
      id,
      outcome: { ok: false, code, message: String(error['message']) },
    };
  }
  return { kind: 'response', id, outcome: { ok: true, result: message['result'] ?? null } };
}

function defaultServerRequest(method: string, params: unknown): unknown {
  if (method !== 'workspace/configuration') return null;
  const items = isRecord(params) && Array.isArray(params['items']) ? params['items'] : [];
  return items.map(() => ({}));
}

export function createLspConnection(
  child: SubprocessHandle,
  options: LspConnectionOptions = {},
): LspConnection {
  const onServerRequest = options.onServerRequest ?? defaultServerRequest;
  const decoder = createFrameDecoder();
  const pending = new Map<number, (outcome: RpcOutcome) => void>();
  let nextId = 1;
  let closed = false;

  const send = (message: Record<string, unknown>): void => {
    if (!closed) child.write(encodeMessage({ jsonrpc: '2.0', ...message }));
  };

  const settleAll = (message: string): void => {
    closed = true;
    for (const settle of pending.values()) settle({ ok: false, code: 'closed', message });
    pending.clear();
  };

  child.onStdout((chunk) => {
    for (const event of decoder.push(chunk)) {
      const incoming = event.kind === 'message' ? classify(event.message) : undefined;
      if (incoming === undefined) {
        options.onMalformed?.(
          event.kind === 'malformed' ? event.reason : 'not a JSON-RPC 2.0 message',
        );
      } else if (incoming.kind === 'response') {
        pending.get(incoming.id)?.(incoming.outcome);
        pending.delete(incoming.id);
      } else if (incoming.kind === 'request') {
        send({ id: incoming.id, result: onServerRequest(incoming.method, incoming.params) });
      } else {
        options.onNotification?.(incoming.method, incoming.params);
      }
    }
  });
  child.onExit((code) => settleAll(`language server exited with code ${String(code)}`));

  return {
    request(method, params) {
      if (closed)
        return Promise.resolve({ ok: false, code: 'closed', message: 'connection closed' });
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params });
    },
    close() {
      if (closed) return;
      settleAll('connection closed');
      child.kill();
    },
    get closed() {
      return closed;
    },
  };
}
