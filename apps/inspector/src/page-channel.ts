// REAL (U2b.1 part 3a-i, BMO-35): the page's side of the WebSocket (owner decision 8a), with the socket
// left to the bundle entry so this runs under vitest.

import type { WebviewToHost } from '@cpg/model';
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
export function queuedChannel(send: (text: string) => void): QueuedChannel {
  let isOpen = false;
  let queue: string[] = [];
  let handler: ((message: unknown) => void) | undefined;

  return {
    post(message: WebviewToHost): void {
      const text = JSON.stringify(message);
      if (isOpen) {
        send(text);
      } else {
        queue.push(text);
      }
    },
    onMessage(next: (message: unknown) => void): void {
      handler = next;
    },
    open(): void {
      if (isOpen) return;
      isOpen = true;
      const pending = queue;
      queue = [];
      for (const text of pending) {
        send(text);
      }
    },
    receive(data: unknown): void {
      if (handler === undefined || typeof data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      handler(parsed);
    },
  };
}

/** What `acquireVsCodeApi()` returns in a VS Code webview: the part the page uses. */
export interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
}

/** The slice of `window` a channel needs. */
export interface PageWindow {
  /** VS Code's webview API, which may be acquired only once; a browser has none. */
  readonly acquireVsCodeApi?: () => VsCodeApi;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

/** The slice of a WebSocket the browser inspector's channel needs. */
export interface PageSocket {
  send(text: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

/**
 * SEAT. The page's channel to its host (controller decision 31).
 * - In a VS Code webview (`acquireVsCodeApi` is there): the API, acquired once. A post is the message
 *   itself, at once; each `message` event's data goes to the handler as it is. One handler, the
 *   latest; data that arrives before any is dropped. `openSocket` is never called, since the panel's
 *   CSP allows no connection.
 * - In a browser: `openSocket()`'s WebSocket, through queuedChannel (owner decision 8a).
 */
export function pageChannel(_page: PageWindow, _openSocket: () => PageSocket): PageChannel {
  throw new Error('SEAT: pageChannel');
}
