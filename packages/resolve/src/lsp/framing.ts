// REAL. LSP base-protocol framing: `Content-Length: <bytes>\r\n\r\n<utf-8 JSON>`. The length counts
// BYTES, so a message with non-ASCII text must be measured after encoding, never by string length.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEPARATOR = [13, 10, 13, 10]; // \r\n\r\n

export function encodeMessage(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${String(body.length)}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header);
  frame.set(body, header.length);
  return frame;
}

export type FrameEvent =
  | { readonly kind: 'message'; readonly message: unknown }
  | { readonly kind: 'malformed'; readonly reason: string };

function indexOfSeparator(bytes: Uint8Array): number {
  for (let i = 0; i + SEPARATOR.length <= bytes.length; i++) {
    if (SEPARATOR.every((b, j) => bytes[i + j] === b)) return i;
  }
  return -1;
}

/** Feed stdout chunks as they arrive; each call returns every frame the chunk completed. */
export function createFrameDecoder(): { push(chunk: Uint8Array): FrameEvent[] } {
  let buffer = new Uint8Array(0);
  return {
    push(chunk) {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      buffer = joined;
      const events: FrameEvent[] = [];
      for (;;) {
        const end = indexOfSeparator(buffer);
        if (end < 0) return events;
        const header = decoder.decode(buffer.subarray(0, end));
        const length = /^content-length: *(\d+) *$/im.exec(header)?.[1];
        if (length === undefined) {
          // The header is unreadable, so the body's extent is unknown: drop through the separator.
          events.push({ kind: 'malformed', reason: `no Content-Length in header "${header}"` });
          buffer = buffer.subarray(end + SEPARATOR.length);
          continue;
        }
        const start = end + SEPARATOR.length;
        if (buffer.length < start + Number(length)) return events;
        const body = decoder.decode(buffer.subarray(start, start + Number(length)));
        buffer = buffer.subarray(start + Number(length));
        try {
          events.push({ kind: 'message', message: JSON.parse(body) as unknown });
        } catch {
          events.push({ kind: 'malformed', reason: `body is not JSON: ${body.slice(0, 80)}` });
        }
      }
    },
  };
}
