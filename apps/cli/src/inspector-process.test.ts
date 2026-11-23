// The inspector child process (owner decision 9a, controller decision 16; U2b.1 part 3b).
// resolveInspectorBin finds the cpg-inspector bin through @cpg/inspector's manifest. spawnInspector
// runs it, resolves on its listening line, and stop() never leaves it running. The real bin needs
// apps/inspector/dist, which `tsc -b` builds before vitest in `bun run check`. The other cases use
// small node scripts in place of the bin.
// Node's own WebSocket plays the page (an app test may import only vitest and @cpg/*).

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveInspectorBin,
  spawnInspector,
  type InspectorProcess,
  type RenderReportMessage,
  type SpawnInspectorOptions,
} from './inspector-process';

const REPO = join(__dirname, '..', '..', '..');

const dirs: string[] = [];
const running: InspectorProcess[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Post-implementation (sabotage group A): a failing test must not leave a child behind. A live
// child keeps the vitest worker from exiting, so a leaked one turns a red test into a hung run
// (mutants 7, 8, 12 and 13 hung until a timeout killed them). Every scripted child exits by itself
// after 30 seconds (unref'd, so a child that is done exits sooner), and start() registers every
// handle for afterEach, including one a rejection test did not expect.
const LIFETIME = 'setTimeout(() => process.exit(99), 30_000).unref();\n';

async function script(body: string): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cpg-cli-child-'));
  dirs.push(dir);
  const bin = join(dir, 'fake-inspector.js');
  await writeFile(bin, LIFETIME + body);
  return { bin, dir };
}

async function start(bin: string, options: SpawnInspectorOptions): Promise<InspectorProcess> {
  const proc = await spawnInspector(bin, options);
  running.push(proc);
  return proc;
}

const LISTEN = `process.stdout.write(JSON.stringify({ type: 'listening', url: 'http://127.0.0.1:4100/' }) + '\\n');`;

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parse(text: unknown): Record<string, unknown> {
  const v: unknown = JSON.parse(String(text));
  if (!isRecord(v)) throw new Error(`not an object: ${String(text)}`);
  return v;
}

const quiet = { onRenderReport: () => {}, log: () => {} };

const RENDER: RenderReportMessage = {
  type: 'render-report',
  epoch: 1,
  seq: 4,
  report: {
    payloadNodeCount: 2,
    renderedNodeCount: 2,
    renderedEdgeCount: 1,
    duplicateEdges: 0,
    droppedNodeIds: [],
    frameMs: 3,
  },
};

describe('resolveInspectorBin (controller decision 16)', () => {
  it("is @cpg/inspector's cpg-inspector bin, absolute, beside its manifest", async () => {
    const manifest = parse(await readFile(join(REPO, 'apps', 'inspector', 'package.json'), 'utf8'));
    const bin = manifest['bin'];
    const entry = isRecord(bin) ? bin['cpg-inspector'] : undefined;
    if (typeof entry !== 'string') throw new Error('apps/inspector has no cpg-inspector bin');
    const resolved = await resolveInspectorBin();
    expect(resolved).toBe(await realpath(join(REPO, 'apps', 'inspector', entry)));
  });
});

describe('spawnInspector with the real bin', () => {
  it(
    'resolves on the listening line, serves the page, relays render-reports, and stops',
    { timeout: 20_000 },
    async () => {
      const reports: RenderReportMessage[] = [];
      const proc = await start(await resolveInspectorBin(), {
        onRenderReport: (m) => void reports.push(m),
        log: () => {},
      });
      const url = new URL(proc.url);
      expect(proc.url).toBe(`http://127.0.0.1:${url.port}/`);
      const page = await fetch(proc.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('cpg-verification');

      const payload = { seq: 4, nodes: [{ id: 'a', type: 'FILE' }], edges: [] };
      proc.send({ type: 'graph', payload });
      const received: Record<string, unknown>[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${url.port}/ws`, {
        headers: { origin: `http://127.0.0.1:${url.port}` },
      });
      socket.addEventListener('message', (event) => void received.push(parse(event.data)));
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve);
        socket.addEventListener('error', reject);
      });
      socket.send(JSON.stringify({ type: 'ready', protocol: 1 }));
      await until(() => received.some((m) => m['type'] === 'graph'), 'the graph message');
      expect(received.find((m) => m['type'] === 'graph')?.['payload']).toEqual(payload);

      socket.send(JSON.stringify(RENDER));
      await until(() => reports.length > 0, 'the relayed render-report');
      expect(reports).toEqual([RENDER]);
      socket.close();

      await proc.stop();
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      await expect(fetch(proc.url)).rejects.toThrow('fetch failed');
    },
  );
});

describe('spawnInspector with a scripted child', () => {
  it('sends each line as one NDJSON line on stdin', { timeout: 20_000 }, async () => {
    const { bin, dir } = await script(
      `${LISTEN}
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (text += c));
process.stdin.on('end', () => require('node:fs').writeFileSync(__filename + '.in', text));`,
    );
    const proc = await start(bin, quiet);
    const payload = { seq: 0, nodes: [], edges: [] };
    const verification = { seq: 0, state: 'pass' as const, checks: [] };
    proc.send({ type: 'graph', payload });
    proc.send({ type: 'verification', report: verification });
    await proc.stop();
    expect(await readFile(join(dir, 'fake-inspector.js.in'), 'utf8')).toBe(
      `${JSON.stringify({ type: 'graph', payload })}\n${JSON.stringify({ type: 'verification', report: verification })}\n`,
    );
  });

  it(
    'render-report lines go to onRenderReport in order; any other line is logged',
    { timeout: 20_000 },
    async () => {
      const second = { ...RENDER, seq: 5 };
      const { bin } = await script(
        `${LISTEN}
process.stdout.write(${JSON.stringify(JSON.stringify(RENDER))} + '\\n');
process.stdout.write('not json\\n');
process.stdout.write(JSON.stringify({ type: 'render-report', seq: 'x' }) + '\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(second))} + '\\n');
process.stdin.resume();`,
      );
      const reports: RenderReportMessage[] = [];
      const logged: string[] = [];
      await start(bin, {
        onRenderReport: (m) => void reports.push(m),
        log: (line) => void logged.push(line),
      });
      await until(() => reports.length >= 2, 'two render-reports');
      expect(reports).toEqual([RENDER, second]);
      expect(logged).toHaveLength(2);
      expect(logged[0]).toBe(
        'cpg: warning: the inspector printed a line that is not a render-report: not json',
      );
    },
  );

  it(
    'a child that exits before listening: rejects naming its exit',
    { timeout: 20_000 },
    async () => {
      const { bin } = await script('process.exitCode = 3;');
      await expect(start(bin, quiet)).rejects.toThrow(/exited.*3/);
    },
  );

  it(
    'a first line that is not the listening line: rejects with it, and the child is killed',
    { timeout: 20_000 },
    async () => {
      const { bin } = await script(
        "process.stdout.write('pid ' + process.pid + '\\n'); setInterval(() => {}, 1000);",
      );
      const error = await start(bin, quiet).then(
        () => '',
        (e: unknown) => String(e),
      );
      const pid = Number(/pid (\d+)/.exec(error)?.[1]);
      expect(pid).toBeGreaterThan(0);
      await until(() => !alive(pid), 'the child to be killed');
    },
  );

  it(
    'no listening line within startMs: rejects, and the child is killed',
    { timeout: 20_000 },
    async () => {
      const { bin, dir } = await script(
        `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'pid'), String(process.pid)); setInterval(() => {}, 1000);`,
      );
      await expect(start(bin, { ...quiet, startMs: 3000 })).rejects.toThrow(/3000 ms/);
      // Round two (review d2): a runner slow enough that the child was killed before it wrote its
      // pid has nothing left to check; otherwise the pid it wrote must be gone.
      const text = await readFile(join(dir, 'pid'), 'utf8').catch(() => '');
      if (text !== '') await until(() => !alive(Number(text)), 'the child to be killed');
    },
  );

  it(
    'stop() ends stdin: a child that exits on EOF is not killed',
    { timeout: 20_000 },
    async () => {
      const { bin } = await script(`${LISTEN}
process.stdin.resume();
process.stdin.on('end', () => { process.exitCode = 0; });`);
      const proc = await start(bin, quiet);
      await proc.stop();
      expect(await proc.exited).toEqual({ code: 0, signal: null });
    },
  );

  it(
    'stop() SIGKILLs a child that ignores EOF once graceMs passes',
    { timeout: 20_000 },
    async () => {
      const { bin } = await script(`${LISTEN}
setInterval(() => {}, 1000);`);
      const proc = await start(bin, { ...quiet, graceMs: 300 });
      await proc.stop();
      expect(await proc.exited).toEqual({ code: null, signal: 'SIGKILL' });
    },
  );

  it(
    'stop() twice is one stop; a send after it is dropped without throwing',
    { timeout: 20_000 },
    async () => {
      const { bin } = await script(`${LISTEN}
process.stdin.resume();`);
      const proc = await start(bin, quiet);
      await Promise.all([proc.stop(), proc.stop()]);
      expect(() =>
        proc.send({ type: 'graph', payload: { seq: 0, nodes: [], edges: [] } }),
      ).not.toThrow();
      await proc.stop();
    },
  );

  it(
    'exited settles when the child exits on its own after listening',
    { timeout: 20_000 },
    async () => {
      const { bin } = await script(`${LISTEN}
setTimeout(() => { process.exitCode = 5; process.stdin.destroy(); }, 50);
process.stdin.resume();`);
      const proc = await start(bin, quiet);
      expect(await proc.exited).toEqual({ code: 5, signal: null });
      // Round two (review b2): a send after the child's own exit is dropped, with no EPIPE escaping
      // (vitest fails the run on an unhandled error).
      expect(() =>
        proc.send({ type: 'graph', payload: { seq: 0, nodes: [], edges: [] } }),
      ).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  );
});

// Round two, after the test review (named defects a6, a7).
describe('spawnInspector and resolveInspectorBin: round two', () => {
  it.each([
    ['another type', { type: 'ready', url: 'http://127.0.0.1:4100/' }],
    ['a numeric url', { type: 'listening', url: 4100 }],
    ['no url', { type: 'listening' }],
  ])(
    'a JSON first line that is not a listening line (%s): rejects (a6)',
    async (_name, first) => {
      const { bin } = await script(
        `process.stdout.write(${JSON.stringify(JSON.stringify(first))} + '\\n'); setInterval(() => {}, 1000);`,
      );
      await expect(start(bin, quiet)).rejects.toThrow(/before its listening line/);
    },
    20_000,
  );

  // a7: a monorepo path would pass the equality above, so pin decision 16's resolution in the source.
  it('locates the bin through require.resolve of @cpg/inspector/package.json, not a fixed path (a7)', async () => {
    // code only: the doc comments quote the call too
    const source = (await readFile(join(__dirname, 'inspector-process.ts'), 'utf8'))
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    expect(source).toContain("require.resolve('@cpg/inspector/package.json')");
    expect(source).not.toMatch(/['"`][^'"`]*dist\/main\.js/);
    expect(source).not.toMatch(/\.\.\/inspector/);
  });
});

// Post-implementation (sabotage group A): mutants 2, 9, 10 and 11 survived. A live child that
// closed its stdin turns the next write into EPIPE, and a line shaped like a render-report that is
// not one must be logged, not relayed.
describe('spawnInspector: post-implementation (sabotage group A)', () => {
  it(
    'a live child that closed its stdin: sends are dropped and no EPIPE escapes',
    { timeout: 20_000 },
    async () => {
      const { bin } = await script(`${LISTEN}
require('node:fs').closeSync(0);
process.stdout.write('stdin closed\\n');
setInterval(() => {}, 1000);`);
      const logged: string[] = [];
      const proc = await start(bin, { ...quiet, log: (line) => void logged.push(line) });
      let hasExited = false;
      void proc.exited.then(() => {
        hasExited = true;
      });
      await until(() => logged.length > 0, 'the child to close its stdin');
      for (let i = 0; i < 3; i++) {
        proc.send({ type: 'graph', payload: { seq: 0, nodes: [], edges: [] } });
      }
      // An EPIPE with no 'error' listener is an unhandled error, which fails the vitest run.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(hasExited).toBe(false);
    },
  );

  it.each([
    ['another type', { ...RENDER, type: 'render-update' }],
    ['a seq that is not a number', { ...RENDER, seq: '4' }],
    ['no seq', { type: RENDER.type, epoch: RENDER.epoch, report: RENDER.report }],
    [
      'a dropped id that is not a string',
      { ...RENDER, report: { ...RENDER.report, droppedNodeIds: ['a', 7] } },
    ],
  ])(
    'a render-report look-alike (%s) is logged, not relayed',
    async (_name, line) => {
      const text = JSON.stringify(line);
      const { bin } = await script(`${LISTEN}
process.stdout.write(${JSON.stringify(text)} + '\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(RENDER))} + '\\n');
process.stdin.resume();`);
      const reports: RenderReportMessage[] = [];
      const logged: string[] = [];
      await start(bin, {
        onRenderReport: (m) => void reports.push(m),
        log: (l) => void logged.push(l),
      });
      await until(() => reports.length > 0, 'the render-report after it');
      expect(reports).toEqual([RENDER]);
      expect(logged).toEqual([
        `cpg: warning: the inspector printed a line that is not a render-report: ${text}`,
      ]);
    },
    20_000,
  );
});
