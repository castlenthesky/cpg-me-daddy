import { describe, expect, it } from 'vitest';
import { createFrameDecoder, encodeMessage } from './framing';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('encodeMessage', () => {
  it('prefixes the JSON body with its length in bytes', () => {
    expect(text(encodeMessage({ a: 1 }))).toBe('Content-Length: 7\r\n\r\n{"a":1}');
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // "é" is one code unit and two bytes; "😀" is two code units and four bytes.
    expect(text(encodeMessage('é😀'))).toBe('Content-Length: 8\r\n\r\n"é😀"');
  });
});

describe('createFrameDecoder', () => {
  it('round-trips messages, including non-ASCII ones', () => {
    const messages = [
      { id: 1, result: null },
      { method: 'x', params: { s: 'é😀' } },
    ];
    const stream = messages.map(encodeMessage);
    const decoder = createFrameDecoder();
    expect(stream.flatMap((frame) => decoder.push(frame))).toEqual(
      messages.map((message) => ({ kind: 'message', message })),
    );
  });

  it('reassembles a frame split at every byte, and splits two frames in one chunk', () => {
    const frame = encodeMessage({ s: 'é😀', n: 42 });
    const decoder = createFrameDecoder();
    const events = Array.from(frame).flatMap((b) => decoder.push(new Uint8Array([b])));
    expect(events).toEqual([{ kind: 'message', message: { s: 'é😀', n: 42 } }]);
    const two = new Uint8Array([...encodeMessage(1), ...encodeMessage(2)]);
    expect(createFrameDecoder().push(two)).toEqual([
      { kind: 'message', message: 1 },
      { kind: 'message', message: 2 },
    ]);
  });

  it('accepts other headers and any header case', () => {
    const frame = bytes('content-type: application/vscode-jsonrpc\r\nCONTENT-LENGTH: 2\r\n\r\n{}');
    expect(createFrameDecoder().push(frame)).toEqual([{ kind: 'message', message: {} }]);
  });

  it('reports a header with no length and a body that is not JSON, then keeps reading', () => {
    const decoder = createFrameDecoder();
    const events = decoder.push(
      new Uint8Array([
        ...bytes('X-Junk: 1\r\n\r\n'),
        ...bytes('Content-Length: 3\r\n\r\n{{{'),
        ...encodeMessage('ok'),
      ]),
    );
    expect(events.map((e) => e.kind)).toEqual(['malformed', 'malformed', 'message']);
    expect(events[2]).toEqual({ kind: 'message', message: 'ok' });
  });
});
