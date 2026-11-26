// The page's side of the inspector's WebSocket (owner decision 8a). The page posts `ready` before
// its socket has opened (graph-app posts it at start), so posts are held until open and then sent in
// order; inbound data reaches the handler only as parsed JSON text. The bundle entry wires the real
// socket's open and message events to open() and receive().

import type { WebviewToHost } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { pageChannel, queuedChannel, SOCKET_PATH, type PageWindow } from './page-channel';

const READY: WebviewToHost = { type: 'ready', protocol: 1 };
const REVEAL: WebviewToHost = { type: 'reveal', nodeId: 'd' };

function channel(): { sent: string[]; received: unknown[]; ch: ReturnType<typeof queuedChannel> } {
  const sent: string[] = [];
  const received: unknown[] = [];
  const ch = queuedChannel((text) => sent.push(text));
  ch.onMessage((message) => received.push(message));
  return { sent, received, ch };
}

describe('queuedChannel', () => {
  it('holds posts until the socket opens, then sends them as JSON in order', () => {
    const { sent, ch } = channel();
    ch.post(READY);
    ch.post(REVEAL);
    expect(sent).toEqual([]);
    ch.open();
    expect(sent).toEqual([JSON.stringify(READY), JSON.stringify(REVEAL)]);
  });

  it('sends a post made after open at once, and never resends the queue', () => {
    const { sent, ch } = channel();
    ch.post(READY);
    ch.open();
    ch.post(REVEAL);
    // Round two (review a1): sent before any second open, not held for it.
    expect(sent).toEqual([JSON.stringify(READY), JSON.stringify(REVEAL)]);
    ch.open();
    expect(sent).toEqual([JSON.stringify(READY), JSON.stringify(REVEAL)]);
  });

  it('hands a JSON text message to the handler as its parsed value', () => {
    const { received, ch } = channel();
    ch.receive('{"type":"graph","protocol":1}');
    ch.receive('[1,2]');
    expect(received).toEqual([{ type: 'graph', protocol: 1 }, [1, 2]]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a truncated document', '{"type":'],
    ['binary data', new ArrayBuffer(4)],
    ['a number', 7],
    ['undefined', undefined],
  ])('drops %s without calling the handler or throwing', (_name, data) => {
    const { received, ch } = channel();
    expect(() => ch.receive(data)).not.toThrow();
    expect(received).toEqual([]);
  });

  // Post-implementation (sabotage #43): one handler, the latest registered.
  it('replaces its handler when onMessage is called again', () => {
    const { received, ch } = channel();
    const later: unknown[] = [];
    ch.onMessage((message) => later.push(message));
    ch.receive('{"type":"graph"}');
    expect(received).toEqual([]);
    expect(later).toEqual([{ type: 'graph' }]);
  });

  it('drops data that arrives before a handler is registered, and never replays it', () => {
    const ch = queuedChannel(() => {});
    expect(() => ch.receive('{"type":"graph"}')).not.toThrow();
    // Round two (review a2): a later handler hears only what arrives after it.
    const received: unknown[] = [];
    ch.onMessage((message) => received.push(message));
    ch.receive('{"type":"verification"}');
    expect(received).toEqual([{ type: 'verification' }]);
  });

  it('serves its socket on /ws', () => {
    expect(SOCKET_PATH).toBe('/ws');
  });
});

// U3.1.1 part 3 (controller decision 31): one bundle, two hosts.
type Data = { readonly data: unknown };

/** A page with or without VS Code's API; `deliver` is what the host sends it. */
function page(api?: unknown) {
  const listeners: ((event: Data) => void)[] = [];
  const posted: unknown[] = [];
  const sockets: { sent: string[]; open: () => void; deliver: (data: unknown) => void }[] = [];
  let acquired = 0;
  const acquireVsCodeApi = () => {
    acquired += 1;
    if (acquired > 1) throw new Error('An instance of the VS Code API has already been acquired');
    return { postMessage: (message: WebviewToHost) => void posted.push(message) };
  };
  const view: PageWindow = {
    ...(api === 'vscode' ? { acquireVsCodeApi } : {}),
    addEventListener: (_type, listener) => void listeners.push(listener),
  };
  const openSocket = () => {
    const opens: (() => void)[] = [];
    const messages: ((event: Data) => void)[] = [];
    const sent: string[] = [];
    sockets.push({
      sent,
      open: () => opens.forEach((run) => run()),
      deliver: (data) => messages.forEach((run) => run({ data })),
    });
    return {
      send: (text: string) => void sent.push(text),
      addEventListener: (type: 'open' | 'message', listener: (event: Data) => void) =>
        void (type === 'open'
          ? opens.push(() => listener({ data: undefined }))
          : messages.push(listener)),
    };
  };
  return {
    channel: pageChannel(view, openSocket),
    posted,
    sockets,
    acquired: () => acquired,
    deliver: (data: unknown) => listeners.forEach((run) => run({ data })),
  };
}

describe('pageChannel in a VS Code webview', () => {
  it('posts each message itself at once, through the API acquired once, and opens no socket', () => {
    const { channel: ch, posted, sockets, acquired } = page('vscode');
    ch.post(READY);
    expect(posted).toEqual([READY]);
    ch.post(REVEAL);
    expect(posted).toEqual([READY, REVEAL]);
    expect(posted[1]).toBe(REVEAL);
    expect(acquired()).toBe(1);
    expect(sockets).toEqual([]);
  });

  it('hands each message event on as it came: no JSON parsing, the latest handler, none replayed', () => {
    const { channel: ch, deliver } = page('vscode');
    const first: unknown[] = [];
    const second: unknown[] = [];
    const message = { type: 'graph', protocol: 1 };
    deliver('before any handler');
    ch.onMessage((data) => first.push(data));
    deliver(message);
    deliver('{"type":"graph"}');
    ch.onMessage((data) => second.push(data));
    deliver(undefined);
    expect(first).toEqual([message, '{"type":"graph"}']);
    expect(first[0]).toBe(message);
    expect(second).toEqual([undefined]);
  });
});

describe('pageChannel in a browser (owner decision 8a, unchanged)', () => {
  it('opens one socket, holds posts until it opens, and never listens on the window', () => {
    const { channel: ch, sockets, deliver, posted } = page();
    const received: unknown[] = [];
    ch.onMessage((message) => received.push(message));
    ch.post(READY);
    expect(sockets.map((socket) => socket.sent)).toEqual([[]]);
    sockets[0]?.open();
    ch.post(REVEAL);
    expect(sockets.map((socket) => socket.sent)).toEqual([
      [JSON.stringify(READY), JSON.stringify(REVEAL)],
    ]);
    deliver({ type: 'graph' });
    expect(received).toEqual([]);
    sockets[0]?.deliver('{"type":"graph","protocol":1}');
    sockets[0]?.deliver('not json');
    expect(received).toEqual([{ type: 'graph', protocol: 1 }]);
    expect(posted).toEqual([]);
  });
});
