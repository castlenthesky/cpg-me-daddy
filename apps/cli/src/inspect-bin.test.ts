// The built `cpg` bin with the real inspector child (U2b.1 part 3b, BMO-35 line 4; owner decision
// 9a; controller decisions 20, 21). It needs apps/cli/dist and apps/inspector/dist, which `tsc -b`
// builds before vitest in `bun run check`. Node's own WebSocket plays the page, so nothing here
// needs the page bundle. The child must never outlive the CLI: Ctrl-C stops it before the CLI exits
// (130), and when the CLI dies by SIGTERM or SIGKILL its stdin pipe closes, so the child exits too.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const APP = join(__dirname, '..');

const dirs: string[] = [];
const procs: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const p of procs.splice(0))
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parse(text: unknown): Record<string, unknown> {
  const v: unknown = JSON.parse(String(text));
  if (!isRecord(v)) throw new Error(`not an object: ${String(text)}`);
  return v;
}

async function binPath(): Promise<string> {
  const pkg = parse(await readFile(join(APP, 'package.json'), 'utf8'));
  const bin = pkg['bin'];
  const entry = isRecord(bin) ? bin['cpg'] : undefined;
  if (typeof entry !== 'string') throw new Error('apps/cli/package.json has no cpg bin');
  return join(APP, entry);
}

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cpg-cli-inspect-bin-'));
  dirs.push(dir);
  return dir;
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Spawns the cpg bin with the caller's CPG_* variables removed (they would redirect the run). */
async function cpg(args: readonly string[], cwd: string) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ['CPG_WORKSPACE', 'CPG_HOST', 'CPG_PORT', 'CPG_GRAPH']) delete env[name];
  const proc = spawn(process.execPath, [await binPath(), ...args], { cwd, env, stdio: 'pipe' });
  procs.push(proc);
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => (out += chunk));
  proc.stderr.on('data', (chunk: string) => (err += chunk));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    proc.on('exit', (code, signal) => resolve({ code, signal })),
  );
  // Round two (review d1): 'close' waits for stdout and stderr to drain; 'exit' may come first.
  const closed = new Promise<void>((resolve) => proc.on('close', () => resolve()));
  return { proc, stdout: () => out, stderr: () => err, exited, closed };
}

const URL_LINE = /^cpg: inspector at (http:\/\/127\.0\.0\.1:\d+\/) /m;

async function urlOf(run: Awaited<ReturnType<typeof cpg>>): Promise<string> {
  await until(
    () => URL_LINE.test(run.stderr()) || run.proc.exitCode !== null,
    'the inspector URL on stderr',
  );
  const url = URL_LINE.exec(run.stderr())?.[1];
  if (url === undefined) throw new Error(`no URL; the CLI said: ${run.stderr()}`);
  return url;
}

/** True once nothing listens at `url` any more. */
async function refused(url: string): Promise<boolean> {
  return fetch(url).then(
    () => false,
    () => true,
  );
}

async function untilRefused(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await refused(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} still answers: the inspector outlived the CLI`);
}

/** A page: Node's WebSocket with the inspector's own origin (controller decision 17). */
async function page(url: string) {
  const { port } = new URL(url);
  const received: Record<string, unknown>[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  socket.addEventListener('message', (event) => void received.push(parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  socket.send(JSON.stringify({ type: 'ready', protocol: 1 }));
  return { socket, received, of: (type: string) => received.filter((m) => m['type'] === type) };
}

const renderOf = (message: Record<string, unknown> | undefined): unknown => {
  const report = message?.['report'];
  const checks = isRecord(report) ? report['checks'] : undefined;
  return Array.isArray(checks)
    ? checks.find((c: unknown) => isRecord(c) && c['id'] === 'render-reconciliation')
    : undefined;
};

const PAYLOAD = {
  seq: 4,
  nodes: [
    { id: 'd', type: 'DIRECTORY', name: '.' },
    { id: 'f', type: 'FILE', name: 'a.ts' },
  ],
  edges: [{ source: 'd', target: 'f', type: 'HAS_ENTRY' }],
};

describe('cpg inspect through the built bin', () => {
  it(
    'renders a saved payload: graph, verdict, render-reconciliation from the page; Ctrl-C is 130 and the child is gone',
    { timeout: 30_000 },
    async () => {
      const dir = await tmp();
      const file = join(dir, 'saved.json');
      const doc = {
        v: 1,
        kind: 'cpg.graph.payload',
        tool: 'cpg@0',
        producedAt: '2026-11-22T00:00:00.000Z',
      };
      await writeFile(file, JSON.stringify({ ...doc, body: PAYLOAD }));
      const run = await cpg(['inspect', file], dir);
      const url = await urlOf(run);

      const p = await page(url);
      await until(
        () => p.of('graph').length > 0 && p.of('verification').length > 0,
        'graph and verdict',
      );
      const graph = p.of('graph')[0];
      expect(graph?.['payload']).toEqual(PAYLOAD);
      expect(renderOf(p.of('verification')[0])).toMatchObject({
        state: 'unavailable',
        detail: `no render-report yet: open ${url}`,
      });

      p.socket.send(
        JSON.stringify({
          type: 'render-report',
          epoch: graph?.['epoch'],
          seq: graph?.['seq'],
          report: {
            payloadNodeCount: 2,
            renderedNodeCount: 2,
            renderedEdgeCount: 1,
            duplicateEdges: 0,
            droppedNodeIds: [],
            frameMs: 2,
          },
        }),
      );
      await until(() => p.of('verification').length >= 2, 'the verdict after the render-report');
      expect(renderOf(p.of('verification')[1])).toMatchObject({
        state: 'pass',
        observed: 2,
        expected: 2,
      });
      await until(
        () => run.stderr().includes('cpg: render-reconciliation pass'),
        'the stderr line',
      );
      // Round two (review b1): the child's stderr is the CLI's, so its own lines reach the terminal.
      p.socket.send(JSON.stringify({ type: 'bogus' }));
      await until(
        () => run.stderr().includes('cpg-inspector: unknown-message: {"type":"bogus"}'),
        "the child's stderr line on the CLI's stderr",
      );
      p.socket.close();

      run.proc.kill('SIGINT');
      expect(await run.exited).toEqual({ code: 130, signal: null });
      await run.closed;
      expect(run.stderr()).toContain('cpg: interrupted');
      // the child was stopped before the CLI exited
      expect(await refused(url)).toBe(true);
      expect(run.stdout()).toBe('');
    },
  );
});

async function indexInspect() {
  const ws = await tmp();
  await mkdir(join(ws, '.git'));
  await writeFile(join(ws, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(ws, 'b.py'), 'b = 2\n');
  const run = await cpg(['index', ws, '--inspect'], ws);
  const url = await urlOf(run);
  // Round two (review d3): stdout is its own pipe, so wait for it rather than assume it came first.
  await until(() => /^written nodes=3 edges=2 dryRun=false$/m.test(run.stdout()), 'the report');
  return { run, url };
}

describe('cpg index --inspect through the built bin: the child never outlives the CLI', () => {
  it('the page gets the workspace graph and its verdict', { timeout: 30_000 }, async () => {
    const { run, url } = await indexInspect();
    const p = await page(url);
    await until(() => p.of('verification').length > 0, 'the verdict');
    const payload = p.of('graph')[0]?.['payload'];
    expect(
      isRecord(payload) && Array.isArray(payload['nodes']) ? payload['nodes'] : [],
    ).toHaveLength(3);
    const report = p.of('verification')[0]?.['report'];
    expect(isRecord(report) ? report['seq'] : undefined).toBe(-1);
    p.socket.close();
    run.proc.kill('SIGINT');
    expect((await run.exited).code).toBe(130);
    expect(await refused(url)).toBe(true);
  });

  it.each([['SIGTERM'], ['SIGKILL']] as const)(
    'the CLI killed by %s: the child reads EOF and exits',
    async (signal) => {
      const { run, url } = await indexInspect();
      run.proc.kill(signal);
      expect((await run.exited).signal).toBe(signal);
      await untilRefused(url);
    },
    30_000,
  );
});
