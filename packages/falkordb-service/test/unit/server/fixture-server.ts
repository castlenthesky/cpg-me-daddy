/**
 * Tiny local origin used by the download and acquisition tests, so the logic is
 * covered without touching the 33 MB real release.
 */

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";

export interface FixtureServer {
  baseUrl: string;
  /** Number of asset requests served — proves cache reuse skips the network. */
  requests: () => number;
  close: () => Promise<void>;
}

export interface FixtureOptions {
  /** Path -> bytes served with 200. Anything else is a 404. */
  files: Record<string, Buffer>;
  /** Paths that accept the connection and then never respond (stall test). */
  blackholes?: readonly string[];
}

export async function startFixtureServer(options: FixtureOptions): Promise<FixtureServer> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\//, "");
    if (options.blackholes?.includes(path)) {
      count += 1;
      // Headers sent, body never arrives: exactly the shape that would hang.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(1));
      return;
    }
    const body = options.files[path];
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    count += 1;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.byteLength),
    });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A TCP port that is bound but never accepted from, i.e. a guaranteed-free port once closed. */
export async function reservedClosedPort(): Promise<number> {
  const server: TcpServer = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a port");
  }
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

/** Minimal fake Redis that answers `+PONG`, for the remote-mode tests. */
export async function startFakeRedis(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createTcpServer((socket) => {
    socket.on("data", () => socket.write("+PONG\r\n"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake redis did not bind");
  }
  return {
    port: address.port,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
