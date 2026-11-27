// `cpg watch` on the built bin (sprint 25, the drift crawl): SIGHUP is the rescan command (controller
// decision 79; main.ts is the one file that listens for it) and the batch it brings says `rescan`
// (decision 80). It needs apps/cli/dist, which `tsc -b` builds before vitest in `bun run check`.
// The drift is a file grown past max_file_size_bytes: a live event for it is dropped (decision 48),
// so only a rescan, whose walk refuses it as `cpg index` does, takes it out of the graph.

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  const closed = new Promise<void>((resolve) => proc.on('close', () => resolve()));
  // Round two (R10): only whole lines; a pipe chunk may end inside one.
  const events = (): Record<string, unknown>[] => out.split('\n').slice(0, -1).map(parse);
  return { proc, events, stderr: () => err, exited, closed };
}

async function until(run: Awaited<ReturnType<typeof cpg>>, check: () => boolean, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    if (run.proc.exitCode !== null || run.proc.signalCode !== null) break;
    // oxlint-disable-next-line no-await-in-loop -- polling a real child process
    await sleep(5);
  }
  throw new Error(`no ${what}; stderr: ${run.stderr()}`);
}

describe('cpg watch, the built bin (decisions 79, 80)', () => {
  it('SIGHUP rescans: `cpg: rescan requested`, then a rescan batch for what no event delivered; the watch goes on until Ctrl-C (130)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpg-cli-watch-bin-'));
    dirs.push(root);
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'cpg.config.yaml'), 'version: 1\nmax_file_size_bytes: 64\n');
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    const run = await cpg(['watch', root], root);
    await until(run, () => run.events().some((e) => e['kind'] === 'ready'), 'ready');

    await writeFile(join(root, 'a.ts'), `export const a = '${'x'.repeat(100)}';\n`);
    // Past the 500 ms ceiling: whatever the backend reported for it has settled, and was dropped.
    await sleep(800);
    expect(run.events().map((e) => e['kind'])).toEqual(['ready']);

    run.proc.kill('SIGHUP');
    await until(run, () => run.events().some((e) => e['kind'] === 'batch'), 'rescan batch');
    // After the implementation (sabotage #1 of the bin group): every SIGHUP is a command, not just the
    // first. The second rescan finds nothing, so it brings no event.
    const asked = (): number => run.stderr().split('cpg: rescan requested\n').length - 1;
    run.proc.kill('SIGHUP');
    await until(run, () => asked() === 2, 'the second rescan request');
    await sleep(200);
    run.proc.kill('SIGINT');
    expect(await run.exited).toEqual({ code: 130, signal: null });
    await run.closed;

    const events = run.events();
    expect(events.map((e) => [e['seq'], e['kind'], e['cause']])).toEqual([
      [0, 'ready', undefined],
      [1, 'batch', 'rescan'],
      [2, 'closed', undefined],
    ]);
    expect(events[1]?.['changes']).toEqual([
      expect.objectContaining({ kind: 'deleted', entry: 'file', path: 'a.ts' }),
    ]);
    expect(run.stderr()).toMatch(
      /^cpg: rescan requested\ncpg: rescan batch 1: 1 change\(s\) in \d+ ms; consumers: memory\n/m,
    );
  }, 30_000);

  // Round two (R9): main.ts listens only while a watch is subscribed, so elsewhere SIGHUP still ends
  // the process (here `cpg index --inspect`, which stays up until Ctrl-C).
  it('in a verb that does not watch, SIGHUP keeps its default: the process ends by it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpg-cli-watch-bin-'));
    dirs.push(root);
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    const run = await cpg(['index', '--inspect', root], root);
    await until(run, () => run.stderr().includes('cpg: inspector at '), 'the inspector URL');
    run.proc.kill('SIGHUP');
    expect(await run.exited).toEqual({ code: null, signal: 'SIGHUP' });
  }, 30_000);
});
