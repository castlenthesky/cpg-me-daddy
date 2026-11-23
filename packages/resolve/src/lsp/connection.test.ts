import { describe, expect, it } from 'vitest';
import type { SubprocessHandle } from '../contract';
import { createLspConnection } from './connection';
import { createFrameDecoder, encodeMessage } from './framing';

/** An in-memory language server: records what the client wrote and lets the test speak back. */
function fakeServer() {
  const decoder = createFrameDecoder();
  const received: unknown[] = [];
  let stdout: ((chunk: Uint8Array) => void) | undefined;
  let exit: ((code: number | null) => void) | undefined;
  let killed = 0;
  const child: SubprocessHandle = {
    write: (chunk) => {
      for (const e of decoder.push(chunk)) if (e.kind === 'message') received.push(e.message);
    },
    onStdout: (listener) => (stdout = listener),
    onExit: (listener) => (exit = listener),
    kill: () => void killed++,
  };
  return {
    child,
    received,
    say: (message: unknown) => stdout?.(encodeMessage(message)),
    raw: (s: string) => stdout?.(new TextEncoder().encode(s)),
    exit: (code: number | null) => exit?.(code),
    killed: () => killed,
  };
}

describe('createLspConnection', () => {
  it('numbers requests and settles each with its own response, in any order', async () => {
    const server = fakeServer();
    const lsp = createLspConnection(server.child);
    const a = lsp.request('initialize', { rootUri: 'file:///w' });
    const b = lsp.request('shutdown');
    expect(server.received).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///w' } },
      { jsonrpc: '2.0', id: 2, method: 'shutdown' },
    ]);
    server.say({ jsonrpc: '2.0', id: 2 });
    server.say({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    expect(await a).toEqual({ ok: true, result: { capabilities: {} } });
    expect(await b).toEqual({ ok: true, result: null });
  });

  it('turns an error response into an outcome with its code', async () => {
    const server = fakeServer();
    const lsp = createLspConnection(server.child);
    const pending = lsp.request('textDocument/definition', {});
    server.say({ jsonrpc: '2.0', id: 1, error: { code: -32801, message: 'content modified' } });
    expect(await pending).toEqual({ ok: false, code: -32801, message: 'content modified' });
    const second = lsp.request('x');
    server.say({ jsonrpc: '2.0', id: 2, error: { message: 'no code' } });
    expect(await second).toEqual({ ok: false, code: -32603, message: 'no code' });
  });

  it('sends notifications without an id and passes server notifications on', () => {
    const server = fakeServer();
    const seen: unknown[] = [];
    const lsp = createLspConnection(server.child, { onNotification: (m, p) => seen.push([m, p]) });
    lsp.notify('initialized', {});
    server.say({ jsonrpc: '2.0', method: '$/progress', params: { value: { kind: 'end' } } });
    expect(server.received).toEqual([{ jsonrpc: '2.0', method: 'initialized', params: {} }]);
    expect(seen).toEqual([['$/progress', { value: { kind: 'end' } }]]);
  });

  it('answers server requests: one empty object per configuration item, null otherwise', () => {
    const server = fakeServer();
    createLspConnection(server.child);
    server.say({
      jsonrpc: '2.0',
      id: 7,
      method: 'workspace/configuration',
      params: { items: [{}, {}] },
    });
    server.say({ jsonrpc: '2.0', id: 'p', method: 'window/workDoneProgress/create', params: {} });
    server.say({ jsonrpc: '2.0', id: 8, method: 'workspace/configuration' });
    expect(server.received).toEqual([
      { jsonrpc: '2.0', id: 7, result: [{}, {}] },
      { jsonrpc: '2.0', id: 'p', result: null },
      { jsonrpc: '2.0', id: 8, result: [] },
    ]);
  });

  it('lets the caller answer server requests', () => {
    const server = fakeServer();
    createLspConnection(server.child, { onServerRequest: (method) => ({ answered: method }) });
    server.say({ jsonrpc: '2.0', id: 1, method: 'client/registerCapability', params: {} });
    expect(server.received).toEqual([
      { jsonrpc: '2.0', id: 1, result: { answered: 'client/registerCapability' } },
    ]);
  });

  it('reports frames that are not JSON-RPC and keeps reading', async () => {
    const server = fakeServer();
    const malformed: string[] = [];
    const lsp = createLspConnection(server.child, { onMalformed: (r) => malformed.push(r) });
    const pending = lsp.request('x');
    server.raw('Content-Length: 1\r\n\r\n{');
    server.say({ id: 1, result: 'no jsonrpc field' });
    server.say({ jsonrpc: '2.0', id: null, method: 'm' });
    server.say({ jsonrpc: '2.0', result: 'no id' });
    server.say({ jsonrpc: '2.0', id: 1, result: 'ok' });
    expect(await pending).toEqual({ ok: true, result: 'ok' });
    expect(malformed).toHaveLength(4);
  });

  it('settles every pending request as closed when the server exits, and refuses new ones', async () => {
    const server = fakeServer();
    const lsp = createLspConnection(server.child);
    const pending = lsp.request('textDocument/definition', {});
    server.exit(1);
    expect(await pending).toEqual({
      ok: false,
      code: 'closed',
      message: 'language server exited with code 1',
    });
    expect(lsp.closed).toBe(true);
    expect(await lsp.request('again')).toMatchObject({ ok: false, code: 'closed' });
    lsp.notify('ignored');
    expect(server.received).toHaveLength(1);
  });

  it('close() settles pending requests and kills the process once', async () => {
    const server = fakeServer();
    const lsp = createLspConnection(server.child);
    const pending = lsp.request('x');
    lsp.close();
    lsp.close();
    expect(await pending).toEqual({ ok: false, code: 'closed', message: 'connection closed' });
    expect(server.killed()).toBe(1);
  });
});
