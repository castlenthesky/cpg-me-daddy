// The `cpg-inspector` bin, spawned as its own process the way part 3b's CLI will start it (owner
// decision 9a). It needs the built dist/main.js, which `tsc -b` writes before vitest runs in
// `bun run check`. A `ws` client plays the page; nothing here needs the real page bundle.
//
// Sprint 36 (stop-list 143): a test that fetches the bundle spawns a private copy of the bin's
// directory, so the page/graph.js beside that copy is the test's alone. The real
// dist/page/graph.js belongs to tools/build-inspector.test.mjs, which builds, removes and rebuilds
// it in another worker during the same run: a bin spawned from dist could find it missing at
// startup and present at the fetch, or the reverse, and log one line where the test expected none
// or two (bin.test.ts:133 under load).

import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const ROOT = join(__dirname, '..');

// Post-implementation (U2b.1 part 3b, sabotage group A): a failing assertion must not leave a bin
// running, or the vitest worker cannot exit and the run hangs. Every bin still running after its
// test is SIGKILLed, every page socket is closed, and every copy of the bin is removed.
const spawned: ChildProcess[] = [];
const sockets: WebSocket[] = [];
const copies: string[] = [];
afterEach(() => {
  for (const p of spawned.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  }
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

// Sprint 36: a copy of the bin whose page/ holds nothing until the test writes it. Round two
// (review 2, 3, 6, 7): the copy is in a fresh directory under the OS temp dir, never in the
// repository, so a killed worker leaks nothing into dist. The directory is realpath'd because
// node gives the bin its real __dirname (macOS keeps the temp dir behind the /var symlink). Its
// node_modules links to the repository's, where `ws` and `@cpg/model` resolve for dist/main.js
// too. Every regular file at the top of the bin's directory is copied. Its subdirectories are not,
// because other tests make and remove their own there (page/, build-inspector-test-<pid>/).
function copyOfBin(): { bin: string; bundlePath: string } {
  const bin = binPath();
  const from = dirname(bin);
  const to = realpathSync(mkdtempSync(join(tmpdir(), 'cpg-inspector-bin-')));
  copies.push(to);
  symlinkSync(join(ROOT, '..', '..', 'node_modules'), join(to, 'node_modules'), 'dir');
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isFile()) copyFileSync(join(from, entry.name), join(to, entry.name));
  }
  return { bin: join(to, basename(bin)), bundlePath: join(to, 'page', 'graph.js') };
}

function spawnBin(bin: string, args: readonly string[] = []) {
  const proc = spawn(process.execPath, [bin, ...args], { stdio: 'pipe' });
  spawned.push(proc);
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

async function listening(child: ReturnType<typeof spawnBin>): Promise<URL> {
  await until(
    () => child.stdout().length > 0 || child.proc.exitCode !== null,
    'the listening line',
  );
  if (child.stdout().length === 0) throw new Error(`the bin exited: ${child.stderr()}`);
  const url = urlOf(child.stdout()[0]);
  expect(url.href).toBe(`http://127.0.0.1:${url.port}/`);
  return url;
}

// Round two (sprint 36 review 1): an error on the page's socket is recorded, never left unhandled,
// and a socket that cannot connect fails the wait at once rather than at the test's timeout.
async function openPage(url: URL) {
  const socket = new WebSocket(`ws://127.0.0.1:${url.port}/ws`, { origin: url.origin });
  sockets.push(socket);
  const received: unknown[] = [];
  const errors: Error[] = [];
  socket.on('message', (data: Buffer, isBinary: boolean) =>
    received.push(isBinary ? 'a binary frame' : JSON.parse(data.toString('utf8'))),
  );
  socket.on('error', (error: Error) => errors.push(error));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, received, errors };
}

describe('the cpg-inspector bin', () => {
  // A spawned node process can take seconds to start on a busy macOS runner.
  it(
    'serves stdin to a page, reports on stdout, and exits 0 when stdin ends',
    { timeout: 20_000 },
    async () => {
      // Round two (review b1), sprint 36: the bin serves page/graph.js beside it, these bytes.
      const { bin, bundlePath } = copyOfBin();
      const script = `/* the bundle beside ${bin} */\n`;
      mkdirSync(dirname(bundlePath));
      writeFileSync(bundlePath, script);
      const child = spawnBin(bin);
      try {
        const url = await listening(child);

        const payload = { seq: 0, nodes: [{ id: 'd', type: 'DIRECTORY' }], edges: [] };
        child.proc.stdin.write(`${JSON.stringify({ type: 'graph', payload })}\n`);
        const { socket, received, errors } = await openPage(url);
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

        const bundle = await fetch(new URL('graph.js', url));
        expect({ status: bundle.status, body: await bundle.text() }).toStrictEqual({
          status: 200,
          body: script,
        });

        expect(errors).toEqual([]);
        child.proc.stdin.end();
        expect(await child.exited).toBe(0);
        expect(child.stderr()).toBe('');
      } finally {
        child.proc.kill();
      }
    },
  );

  // Round two (U2b.1 part 3b review c2), sprint 36: with no bundle beside it, the bin names the path
  // it looked at once at startup and once for the request it answers 404, and still exits 0.
  it(
    'names a missing bundle beside it at startup and on a request, and still exits 0',
    { timeout: 20_000 },
    async () => {
      const { bin, bundlePath } = copyOfBin();
      // Round two (sprint 36 review 4): page/ exists and holds only graph.js.map, so a check of the
      // directory, or of the sourcemap, finds something and must still name the missing graph.js.
      mkdirSync(dirname(bundlePath));
      writeFileSync(`${bundlePath}.map`, '{}\n');
      const child = spawnBin(bin);
      try {
        const url = await listening(child);
        const bundle = await fetch(new URL('graph.js', url));
        expect(bundle.status).toBe(404);

        child.proc.stdin.end();
        expect(await child.exited).toBe(0);
        const lines = child.stderr().split('\n').slice(0, -1);
        expect(lines.map((line) => line.includes(bundlePath))).toEqual([true, true]);
      } finally {
        child.proc.kill();
      }
    },
  );

  // Round two (sprint 36 review 5): the real bin, from where it is installed. Its directory is the
  // one `bun run build:inspector` writes page/graph.js into (apps/inspector/dist), and with no
  // arguments it listens and exits 0 when stdin ends. tools/build-inspector.test.mjs may build or
  // remove that bundle during this run, so the only stderr allowed is a line that names it.
  it(
    'runs from apps/inspector/dist, where build:inspector writes page/graph.js, and exits 0',
    { timeout: 20_000 },
    async () => {
      expect(dirname(binPath())).toBe(join(ROOT, 'dist'));
      const child = spawnBin(binPath());
      try {
        await listening(child);
        child.proc.stdin.end();
        expect(await child.exited).toBe(0);
        const realBundle = join(realpathSync(ROOT), 'dist', 'page', 'graph.js');
        const lines = child.stderr().split('\n').slice(0, -1);
        expect(lines.filter((line) => !line.includes(realBundle))).toEqual([]);
      } finally {
        child.proc.kill();
      }
    },
  );

  it(
    'refuses arguments with exit 2 and a stderr line, and serves nothing',
    { timeout: 20_000 },
    async () => {
      const child = spawnBin(binPath(), ['--port', '8080']);
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
    const child = spawnBin(binPath(), ['-']);
    try {
      expect(await child.exited).toBe(2);
      expect(child.stdout()).toEqual([]);
    } finally {
      child.proc.kill();
    }
  });
});
