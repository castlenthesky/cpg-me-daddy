// SEAT (U2b.1 part 3a-i, BMO-35): the page's side of the WebSocket (owner decision 8a), with the socket
// left to the bundle entry so this runs under vitest.

import type { PageChannel } from './graph-app';

/** The inspector's WebSocket path, on the page's own origin (its server is part 3a-ii). */
export const SOCKET_PATH = '/ws';

/** A PageChannel the bundle entry feeds from a WebSocket's open and message events. */
export interface QueuedChannel extends PageChannel {
  /** The socket opened: send everything posted so far, in order; later posts go straight out. */
  open(): void;
  /** A message event's data: a JSON string goes to the handler; anything else is dropped. */
  receive(data: unknown): void;
}

/**
 * Posts as JSON text through `send`, holding posts made before `open()` (the page posts `ready`
 * before its socket has opened). One handler; data that is not a JSON string is dropped.
 */
export function queuedChannel(_send: (text: string) => void): QueuedChannel {
  throw new Error('SEAT: queuedChannel is U2b.1 part 3a-i');
}
