// REAL (U2b.1 part 3a-ii, BMO-35): the inspector's local static server and its WebSocket (owner
// decisions 8a, 10a; controller decisions 15, 17).

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HostToWebview } from '@cpg/model';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { WebviewTransport } from './host';
import { SOCKET_PATH } from './page-channel';
import { graphShellHtml } from './shell';

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

function pathnameOf(url: string | undefined): string {
  const raw = url ?? '';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : String(error);
}

function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function refuseUpgrade(socket: Duplex, status: '403 Forbidden' | '404 Not Found'): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
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
 * goes to `attach` as a WebviewTransport whose `onMessage` supports several subscriptions, each
 * disposed on its own. JSON text goes both ways; a text frame that is not JSON, or a binary frame,
 * is dropped with a log line saying it is not JSON. Posting to a page that has gone does nothing.
 */
export async function startInspectorServer(
  options: InspectorServerOptions,
): Promise<InspectorServer> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('inspector server has no bound port'));
        return;
      }
      resolve(address.port);
    });
  });

  const expectedHost = `127.0.0.1:${String(port)}`;
  const expectedOrigin = `http://${expectedHost}`;
  const connectSrc = `ws://${expectedHost}`;
  const url = `${expectedOrigin}/`;

  const logDiagnostic = (detail: string | Error): void => {
    options.log(String(detail));
  };

  let activeSocket: WebSocket | undefined;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.host !== expectedHost) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden\n');
      return;
    }

    const path = pathnameOf(req.url);
    if (req.method === 'GET' && path === '/') {
      const nonce = randomBytes(16).toString('base64');
      const html = graphShellHtml({
        scriptUri: SCRIPT_PATH,
        cspSource: INSPECTOR_CSP_SOURCE,
        nonce,
        connectSrc,
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && path === SCRIPT_PATH) {
      try {
        const bytes = await readFile(options.bundlePath);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(bytes);
      } catch (error: unknown) {
        const code = errorCode(error);
        logDiagnostic(
          `cannot read the page bundle ${options.bundlePath} (${code}); build it with bun run build:inspector`,
        );
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found\n');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
  };

  const acceptSocket = (socket: WebSocket): void => {
    activeSocket?.close();
    activeSocket = socket;
    socket.on('error', logDiagnostic);

    const handlers = new Set<(message: unknown) => void>();
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        logDiagnostic('websocket message is not JSON (binary frame)');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToText(data));
      } catch {
        logDiagnostic('websocket message is not JSON');
        return;
      }
      for (const handler of handlers) {
        handler(parsed);
      }
    });

    const transport: WebviewTransport = {
      cspSource: INSPECTOR_CSP_SOURCE,
      post(message: HostToWebview): void {
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(JSON.stringify(message));
        } catch {
          // post is lossy by contract (C-EXT WebviewTransport)
        }
      },
      onMessage(handler: (message: unknown) => void) {
        handlers.add(handler);
        return {
          dispose(): void {
            handlers.delete(handler);
          },
        };
      },
    };

    options.attach(transport);
  };

  server.on('request', (req, res) => {
    void handleRequest(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.headers.host !== expectedHost || req.headers.origin !== expectedOrigin) {
      refuseUpgrade(socket, '403 Forbidden');
      return;
    }
    if (pathnameOf(req.url) !== SOCKET_PATH) {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    wss.handleUpgrade(req, socket, head, acceptSocket);
  });

  return {
    url,
    port,
    close(): Promise<void> {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      server.closeAllConnections();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
