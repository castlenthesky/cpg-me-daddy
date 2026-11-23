// SEAT (U2b.1 part 3a-ii, BMO-35): the inspector's local static server and its WebSocket (owner
// decisions 8a, 10a; controller decisions 15, 17).

import type { WebviewTransport } from './host';

/** The page script's path: fixed, never taken from a request (controller decision 15). */
export const SCRIPT_PATH = '/graph.js';
/** The shell's style-src source and the transport's cspSource. */
export const INSPECTOR_CSP_SOURCE = "'self'";

export interface InspectorServerOptions {
  /** Called with each new page connection's transport (InspectorHost.attach). */
  readonly attach: (transport: WebviewTransport) => void;
  /** The page bundle (graph.js), read on each request. */
  readonly bundlePath: string;
  /** One diagnostic line: a bundle it cannot read, a WebSocket message it drops. */
  readonly log: (line: string) => void;
}

export interface InspectorServer {
  /** `http://127.0.0.1:<port>/`. */
  readonly url: string;
  readonly port: number;
  /** Stops listening and drops every connection, WebSockets included. */
  close(): Promise<void>;
}

/**
 * Listens on 127.0.0.1 on an ephemeral port. Any request whose `Host` is not `127.0.0.1:<port>` is
 * refused with 403 (controller decision 17: DNS rebinding). Otherwise, by path (the query ignored):
 * - `GET /`: graphShellHtml with a fresh node:crypto nonce per load, SCRIPT_PATH,
 *   INSPECTOR_CSP_SOURCE and connect-src `ws://127.0.0.1:<own port>` (decisions 10a, 15). Nothing in
 *   it comes from the request;
 * - `GET /graph.js`: the bundle, read with async fs on each request. One it cannot read is a 404
 *   and a log line naming the path and `bun run build:inspector`;
 * - anything else: 404.
 *
 * A WebSocket upgrade is refused with 403 unless its `Host` is `127.0.0.1:<port>` and its `Origin`
 * is exactly `http://127.0.0.1:<port>` (decision 17: WebSockets bypass CORS). It is refused unless
 * its path is SOCKET_PATH. An accepted one (`ws`, decision 8a) closes the previous page's socket and
 * goes to `attach` as a WebviewTransport. JSON text goes both ways; a text frame that is not JSON,
 * or a binary frame, is dropped with a log line saying it is not JSON. Posting to a page that has
 * gone does nothing.
 */
export function startInspectorServer(_options: InspectorServerOptions): Promise<InspectorServer> {
  throw new Error('SEAT: startInspectorServer is U2b.1 part 3a-ii');
}
