// The `cpg-inspector` bin, spawned as its own process the way part 3b's CLI will start it (owner
// decision 9a). It needs the built dist/main.js, which `tsc -b` writes before vitest runs in
// `bun run check`. A `ws` client plays the page; nothing here needs the page bundle.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const ROOT = join(__dirname, '..');

function binPath(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const bin =
    typeof pkg === 'object' && pkg !== null && 'bin' in pkg && typeof pkg.bin === 'object'
      ? pkg.bin
      : undefined;
  const entry =
    bin !== null && bin !== undefined && 'cpg-inspector' in bin ? bin['cpg-inspector'] : undefined;
  if (typeof entry !== 'string')
    throw new Error('apps/inspector/package.json has no cpg-inspector bin');
  return join(ROOT, entry);
}

function spawnBin(args: readonly string[] = []) {
  const proc = spawn(process.execPath, [binPath(), ...args], { stdio: 'pipe' });
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => (out += chunk));
  proc.stderr.on('data', (chunk: string) => (err += chunk));
  // Round two (review d1, d2): 'close' waits for stdio to drain, and only complete lines count.
  const exited = new Promise<number | null>((resolve) => proc.on('close', (code) => resolve(code)));
  return {
    proc,
    stdout: () =>
      out
        .split('\n')
        .slice(0, -1)
        .filter((l) => l !== ''),
    stderr: () => err,
    exited,
  };
}

// Round two (review d3): 15 seconds, inside each test's 20.
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function urlOf(first: string | undefined): URL {
  const parsed: unknown = JSON.parse(first ?? 'null');
  if (typeof parsed !== 'object' || parsed === null || !('url' in parsed)) {
    throw new Error(`not a listening line: ${String(first)}`);
  }
  if (typeof parsed.url !== 'string') throw new Error(`not a listening line: ${String(first)}`);
  return new URL(parsed.url);
}

describe('the cpg-inspector bin', () => {
  // A spawned node process can take seconds to start on a busy macOS runner.
  it(
    'serves stdin to a page, reports on stdout, and exits 0 when stdin ends',
    { timeout: 20_000 },
    async () => {
      const child = spawnBin();
      try {
        await until(
          () => child.stdout().length > 0 || child.proc.exitCode !== null,
          'the listening line',
        );
        if (child.stdout().length === 0) throw new Error(`the bin exited: ${child.stderr()}`);
        const url = urlOf(child.stdout()[0]);
        expect(url.href).toBe(`http://127.0.0.1:${url.port}/`);

        const payload = { seq: 0, nodes: [{ id: 'd', type: 'DIRECTORY' }], edges: [] };
        child.proc.stdin.write(`${JSON.stringify({ type: 'graph', payload })}\n`);
        const socket = new WebSocket(`ws://127.0.0.1:${url.port}/ws`, { origin: url.origin });
        const received: unknown[] = [];
        socket.on('message', (data: Buffer, isBinary: boolean) =>
          received.push(isBinary ? 'a binary frame' : JSON.parse(data.toString('utf8'))),
        );
        await new Promise<void>((resolve) => socket.on('open', () => resolve()));
        socket.send(JSON.stringify({ type: 'ready', protocol: 1 }));
        await until(() => received.length === 1, 'the graph');
        expect(received).toStrictEqual([{ type: 'graph', protocol: 1, epoch: 1, seq: 0, payload }]);

        const renderReport = {
          type: 'render-report',
          epoch: 1,
          seq: 0,
          report: {
            payloadNodeCount: 1,
            renderedNodeCount: 1,
            renderedEdgeCount: 0,
            duplicateEdges: 0,
            droppedNodeIds: [],
            frameMs: 1,
          },
        };
        socket.send(JSON.stringify(renderReport));
        await until(() => child.stdout().length === 2, 'the render-report line');
        expect(JSON.parse(child.stdout()[1] ?? '')).toStrictEqual(renderReport);

        // Round two (review b1): the bin serves dist/page/graph.js beside it. `check` doesn't build
        // the bundle, so either it is served, or the one stderr line names where the bin looked.
        const bundle = await fetch(new URL('graph.js', url));
        const bundlePath = join(ROOT, 'dist', 'page', 'graph.js');
        expect([200, 404]).toContain(bundle.status);

        child.proc.stdin.end();
        expect(await child.exited).toBe(0);
        const lines = child.stderr().split('\n').slice(0, -1);
        const logged = bundle.status === 200 ? [] : [true];
        expect(lines.map((line) => line.includes(bundlePath))).toEqual(logged);
      } finally {
        child.proc.kill();
      }
    },
  );

  it(
    'refuses arguments with exit 2 and a stderr line, and serves nothing',
    { timeout: 20_000 },
    async () => {
      const child = spawnBin(['--port', '8080']);
      try {
        expect(await child.exited).toBe(2);
        expect(child.stderr()).toBe(
          'cpg-inspector: takes no arguments; it reads NDJSON on stdin\n',
        );
        expect(child.stdout()).toEqual([]);
      } finally {
        child.proc.kill();
      }
    },
  );

  // Post-implementation (sabotage main #1): one argument is refused too, not only two.
  it('refuses a single argument with exit 2', { timeout: 20_000 }, async () => {
    const child = spawnBin(['-']);
    try {
      expect(await child.exited).toBe(2);
      expect(child.stdout()).toEqual([]);
    } finally {
      child.proc.kill();
    }
  });
});
