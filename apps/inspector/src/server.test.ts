// The inspector's local server, over real sockets. It binds 127.0.0.1 on an ephemeral port. It serves
// the shell with a fresh nonce per load and connect-src set to its own ws://127.0.0.1:<port>
// (decisions 10a, 15: nothing comes from the request). It serves the bundle, read on each request
// (no sync fs, C-EXT may_not). It hands each WebSocket on /ws to `attach` as a WebviewTransport
// (decision 8a). Controller decision 17: a foreign Host, or a WebSocket Origin other than
// http://127.0.0.1:<port>, is refused with 403. The client is `ws`, which sends an Origin only when
// told to.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { WebviewTransport } from './host';
import { graphShellHtml } from './shell';
import {
  INSPECTOR_CSP_SOURCE,
  SCRIPT_PATH,
  startInspectorServer,
  type InspectorServer,
} from './server';

const BUNDLE = '/* the page bundle */ console.log("graph");\n';

let dir = '';
const open: InspectorServer[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpg-inspector-'));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(writeBundle = true) {
  const bundlePath = join(dir, 'graph.js');
  if (writeBundle) await writeFile(bundlePath, BUNDLE);
  const transports: WebviewTransport[] = [];
  const logs: string[] = [];
  const server = await startInspectorServer({
    attach: (transport) => transports.push(transport),
    bundlePath,
    log: (line) => logs.push(line),
  });
  open.push(server);
  return { server, transports, logs, bundlePath };
}

interface Response {
  readonly status: number;
  readonly type: string | undefined;
  readonly body: string;
}

function get(
  port: number,
  path: string,
  options: { method?: string; host?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: options.host ?? '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const NONCE = /script-src 'nonce-([^']+)';/;

function nonceOf(body: string): string {
  const match = NONCE.exec(body);
  if (match?.[1] === undefined) throw new Error(`no nonce in ${body}`);
  return match[1];
}

/** The shell the server must serve on `port`, written from decisions 10a and 15, not its constants. */
const shellFor = (port: number, nonce: string): string =>
  graphShellHtml({
    scriptUri: '/graph.js',
    cspSource: "'self'",
    nonce,
    connectSrc: `ws://127.0.0.1:${port}`,
  });

interface Client {
  readonly socket: WebSocket;
  readonly received: unknown[];
  /** 'open', or the client's error message (`Unexpected server response: 403`). */
  readonly outcome: Promise<string>;
  readonly closed: Promise<void>;
}

function connect(
  port: number,
  options: { origin?: string; host?: string; path?: string } = {},
): Client {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, {
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.host === undefined ? {} : { headers: { Host: options.host } }),
  });
  const received: unknown[] = [];
  socket.on('message', (data: Buffer) => received.push(JSON.parse(data.toString('utf8'))));
  const outcome = new Promise<string>((resolve) => {
    socket.on('open', () => resolve('open'));
    socket.on('error', (error) => resolve(error.message));
  });
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  return { socket, received, outcome, closed };
}

const own = (server: InspectorServer): string => `http://127.0.0.1:${server.port}`;

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A page connected from the server's own origin, and the transport attach received for it. */
async function page(started: Awaited<ReturnType<typeof start>>) {
  const client = connect(started.server.port, { origin: own(started.server) });
  expect(await client.outcome).toBe('open');
  await until(() => started.transports.length > 0, 'attach');
  const transport = started.transports.at(-1);
  if (transport === undefined) throw new Error('no transport');
  return { client, transport };
}

describe('startInspectorServer: HTTP', () => {
  it('listens on 127.0.0.1 on an ephemeral port and names it in its url', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    expect(a.server.url).toBe(`http://127.0.0.1:${a.server.port}/`);
    expect(a.server.port).toBeGreaterThan(0);
    expect(b.server.port).not.toBe(a.server.port);
  });

  const external = Object.values(networkInterfaces())
    .flat()
    .find((info) => info?.family === 'IPv4' && !info.internal);
  it.skipIf(external === undefined)('is unreachable on any address but 127.0.0.1', async () => {
    const { server } = await start();
    const host = external?.address ?? 'unreachable.invalid';
    await expect(get(server.port, '/', { host })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("serves the shell at /: its own connect-src, the fixed script path, 'self' styles", async () => {
    const { server } = await start();
    const res = await get(server.port, '/');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html; charset=utf-8');
    expect(res.body).toBe(shellFor(server.port, nonceOf(res.body)));
    expect([SCRIPT_PATH, INSPECTOR_CSP_SOURCE]).toEqual(['/graph.js', "'self'"]);
  });

  it('makes a fresh nonce of at least 128 bits on every load', async () => {
    const { server } = await start();
    const loads = await Promise.all([1, 2, 3].map(() => get(server.port, '/')));
    const nonces = loads.map((res) => nonceOf(res.body));
    expect(new Set(nonces).size).toBe(3);
    for (const nonce of nonces) {
      expect(Buffer.from(nonce, 'base64').length).toBeGreaterThanOrEqual(16);
    }
  });

  it('takes nothing in the shell from the request, query included (decision 15)', async () => {
    const { server } = await start();
    const res = await get(server.port, "/?nonce=evil'&scriptUri=//evil.example/x.js", {
      headers: { 'X-Forwarded-Host': 'evil.example', Referer: 'http://evil.example/' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(shellFor(server.port, nonceOf(res.body)));
    expect(res.body).not.toContain('evil');
  });

  it.each([
    ['a foreign name', () => 'evil.example'],
    ['a foreign name on its port', (port: number) => `evil.example:${port}`],
    ['localhost on its port', (port: number) => `localhost:${port}`],
    ['[::1] on its port', (port: number) => `[::1]:${port}`],
    ['127.0.0.1 with no port', () => '127.0.0.1'],
    ['127.0.0.1 on another port', (port: number) => `127.0.0.1:${port + 1}`],
  ])('refuses any request whose Host is %s with 403 (DNS rebinding)', async (_name, host) => {
    const { server } = await start();
    for (const path of ['/', '/graph.js', '/nope']) {
      const res = await get(server.port, path, { headers: { Host: host(server.port) } });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain('<html');
      expect(res.body).not.toContain('the page bundle');
    }
  });

  it('serves the bundle at /graph.js as JavaScript, read from disk on each request', async () => {
    const { server, bundlePath } = await start();
    const first = await get(server.port, '/graph.js');
    expect(first.status).toBe(200);
    expect(first.type).toBe('text/javascript; charset=utf-8');
    expect(first.body).toBe(BUNDLE);
    await writeFile(bundlePath, 'rebuilt();\n');
    expect((await get(server.port, '/graph.js')).body).toBe('rebuilt();\n');
  });

  it('answers a missing bundle with 404 and one log line naming it and the build command', async () => {
    const { server, logs, bundlePath } = await start(false);
    expect((await get(server.port, '/graph.js')).status).toBe(404);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(bundlePath);
    expect(logs[0]).toContain('bun run build:inspector');
  });

  it.each([
    ['GET', '/nope'],
    ['GET', '/index.html'],
    ['GET', '/graph.js.map'],
    ['GET', '/ws'],
    ['POST', '/'],
    ['DELETE', '/graph.js'],
  ])('answers %s %s with 404', async (method, path) => {
    const { server } = await start();
    expect((await get(server.port, path, { method })).status).toBe(404);
  });
});

describe('startInspectorServer: the WebSocket transport (decision 8a)', () => {
  it('hands a connection from its own origin to attach, carrying JSON both ways', async () => {
    const started = await start();
    const { client, transport } = await page(started);
    expect(started.transports).toHaveLength(1);
    expect(transport.cspSource).toBe("'self'");

    const heard: unknown[] = [];
    transport.onMessage((message) => heard.push(message));
    client.socket.send(JSON.stringify({ type: 'ready', protocol: 1 }));
    await until(() => heard.length === 1, 'the page message');
    expect(heard).toEqual([{ type: 'ready', protocol: 1 }]);

    const graph = {
      type: 'graph',
      protocol: 1,
      epoch: 1,
      seq: 0,
      payload: { seq: 0, nodes: [], edges: [] },
    } as const;
    transport.post(graph);
    await until(() => client.received.length === 1, 'the host message');
    expect(client.received).toEqual([graph]);
  });

  it('stops delivering to a handler once its subscription is disposed', async () => {
    const { client, transport } = await page(await start());
    const heard: unknown[] = [];
    transport.onMessage((message) => heard.push(message)).dispose();
    const probe: unknown[] = [];
    transport.onMessage((message) => probe.push(message));
    client.socket.send(JSON.stringify({ type: 'reveal', nodeId: 'x' }));
    await until(() => probe.length === 1, 'the probe message');
    expect(heard).toEqual([]);
  });

  it('drops a text frame that is not JSON and a binary frame, each with a log line', async () => {
    const started = await start();
    const { client, transport } = await page(started);
    const heard: unknown[] = [];
    transport.onMessage((message) => heard.push(message));
    client.socket.send('not json');
    client.socket.send(Buffer.from(JSON.stringify({ type: 'reveal', nodeId: 'b' })), {
      binary: true,
    });
    client.socket.send(JSON.stringify({ type: 'reveal', nodeId: 'x' }));
    await until(() => heard.length === 1, 'the JSON message');
    expect(heard).toEqual([{ type: 'reveal', nodeId: 'x' }]);
    expect(started.logs).toHaveLength(2);
    expect(started.logs.every((line) => line.includes('not JSON'))).toBe(true);
  });

  it.each([
    ['no Origin', () => ({})],
    ['a foreign Origin', () => ({ origin: 'http://evil.example' })],
    ["the opaque Origin 'null'", () => ({ origin: 'null' })],
    ['its host on another port', (port: number) => ({ origin: `http://127.0.0.1:${port + 1}` })],
    ['localhost on its port', (port: number) => ({ origin: `http://localhost:${port}` })],
    ['https on its port', (port: number) => ({ origin: `https://127.0.0.1:${port}` })],
    ['a trailing slash', (port: number) => ({ origin: `http://127.0.0.1:${port}/` })],
    [
      'its own Origin but a foreign Host',
      (port: number) => ({ origin: `http://127.0.0.1:${port}`, host: 'evil.example' }),
    ],
  ])('refuses a WebSocket with %s with 403 (cross-site hijacking)', async (_name, options) => {
    const { server, transports } = await start();
    const client = connect(server.port, options(server.port));
    expect(await client.outcome).toBe('Unexpected server response: 403');
    expect(transports).toEqual([]);
  });

  it('refuses a WebSocket on another path', async () => {
    const { server, transports } = await start();
    const client = connect(server.port, { origin: own(server), path: '/socket' });
    expect(await client.outcome).not.toBe('open');
    expect(transports).toEqual([]);
  });

  it('closes the previous page when a new one connects (attach replaces)', async () => {
    const started = await start();
    const first = await page(started);
    const second = await page(started);
    await first.client.closed;
    expect(started.transports).toHaveLength(2);
    expect(second.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('posts nothing and throws nothing once the page has gone (post is lossy)', async () => {
    const { client, transport } = await page(await start());
    client.socket.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const graph = {
      type: 'graph',
      protocol: 1,
      epoch: 1,
      seq: 0,
      payload: { seq: 0, nodes: [], edges: [] },
    } as const;
    expect(() => transport.post(graph)).not.toThrow();
  });

  it('close() drops every connection and stops listening', async () => {
    const started = await start();
    open.splice(open.indexOf(started.server), 1);
    const { client } = await page(started);
    await started.server.close();
    await client.closed;
    await expect(get(started.server.port, '/')).rejects.toThrow(/ECONNREFUSED/);
  });
});
