// The page's side of the inspector's WebSocket (owner decision 8a). The page posts `ready` before
// its socket has opened (graph-app posts it at start), so posts are held until open and then sent in
// order; inbound data reaches the handler only as parsed JSON text. The bundle entry wires the real
// socket's open and message events to open() and receive().

import type { WebviewToHost } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { queuedChannel, SOCKET_PATH } from './page-channel';

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

  it('drops data that arrives before a handler is registered', () => {
    const ch = queuedChannel(() => {});
    expect(() => ch.receive('{"type":"graph"}')).not.toThrow();
  });

  it('serves its socket on /ws', () => {
    expect(SOCKET_PATH).toBe('/ws');
  });
});
