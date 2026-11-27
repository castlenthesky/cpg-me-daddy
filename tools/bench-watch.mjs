#!/usr/bin/env node
// REAL (U4.2.1 part b, BMO-60; controller decision 68): the T0 -> T3 benchmark of `cpg watch`, run by
// hand on a built tree. Not a gate and not in CI (its spawn path is exercised by its test).
//
// Usage: node tools/bench-watch.mjs [--saves N]   (bun run bench:watch; N defaults to 50)
//
// It makes a temp workspace (`.git/` and 20 files `src/f00.ts`..`src/f19.ts`), reads the resolved
// `watch.trailingMs`/`watch.ceilingMs` from `cpg config <tmp> --format json`, spawns the built
// `apps/cli/dist/main.js watch <tmp> --quiet`, and waits for `ready`. It then makes N saves of
// `src/f00.ts`, each with distinct content and each 2 x ceilingMs after the one before; T0 is
// `Date.now()` just before the write. After the last save it waits until that save is matched or
// 5000 ms pass, SIGINTs the child, and requires exit code 130 with a `closed` event as the last
// stdout line. It prints `benchLines`, then `exit: 130 after SIGINT; last event closed`, and exits
// 0. It exits 1 when the exit check fails (the reason on stderr) or the CLI is not built
// (`bench-watch: build first (bun run compile): <path> is missing`), and 2 when `--saves` is not a
// positive integer (`bench-watch: --saves must be a positive integer, got '<v>'`). `<platform>` is
// `process.platform`, `os.release()` and `process.arch`; `<cpu>` the first CPU's model and the count.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { percentile } from './spike-report.mjs';

/** A save with no batch within this many ms of its T0 is a miss. */
export const MISS_MS = 5000;

/**
 * Pairs each save with the batch that made it visible. Save i matches the first event, in stream
 * order, with `kind: 'batch'`, `at >= t0`, and a change whose `path` is the save's path. When there
 * is none, or its `at - t0` is over `missMs`, the save is a miss (null). Several saves may match one
 * batch. Inputs are left as they are.
 *
 * @param {readonly { path: string, t0: number }[]} saves in write order
 * @param {readonly any[]} events the parsed stdout lines, in stream order
 * @param {number} [missMs]
 * @returns {({ t0t3: number, total: number } | null)[]} per save: `at - t0`, and the batch's
 *   `latencyMs.total`
 */
export function matchSaves(saves, events, missMs = MISS_MS) {
  // REAL
  return saves.map(({ path, t0 }) => {
    const hit = events.find(
      (e) => e?.kind === 'batch' && e.at >= t0 && e.changes.some((c) => c.path === path),
    );
    if (hit === undefined) return null;
    const t0t3 = hit.at - t0;
    if (t0t3 > missMs) return null;
    return { t0t3, total: hit.latencyMs.total };
  });
}

/**
 * The printed report, in this order:
 * - `cpg watch benchmark: <n> saves of <file>, <spacingMs> ms apart; trailingMs <t>, ceilingMs <c>`
 * - `platform: <platform>; cpu: <cpu>`
 * - `T0->T3: p50 <a> ms, p95 <b> ms, n=<k>; consumers: <list>`
 * - `latencyMs.total: p50 <a> ms, p95 <b> ms, n=<k>; consumers: <list>`
 * - `misses: <m> of <n> (no batch within 5000 ms)`
 * where `<n>` is `matches.length`, `<k>` the matched saves, p50/p95 the nearest-rank percentiles of
 * the matched saves' `t0t3` and `total`, and `<list>` the enabled set joined by `, `. With no
 * matched save, each of the two number lines is `<name>: not measured: every save missed;
 * consumers: <list>`.
 *
 * @param {{ file: string, spacingMs: number, trailingMs: number, ceilingMs: number,
 *   consumers: readonly string[], platform: string, cpu: string,
 *   matches: readonly ({ t0t3: number, total: number } | null)[] }} run
 * @returns {string[]}
 */
export function benchLines(run) {
  // REAL
  const { file, spacingMs, trailingMs, ceilingMs, consumers, platform, cpu, matches } = run;
  const total = matches.length;
  const hits = matches.filter((entry) => entry !== null);
  const misses = total - hits.length;
  const list = consumers.join(', ');
  const metricLine = (name, samples) =>
    samples.length === 0
      ? `${name}: not measured: every save missed; consumers: ${list}`
      : `${name}: p50 ${String(percentile(samples, 50))} ms, p95 ${String(percentile(samples, 95))} ms, n=${String(samples.length)}; consumers: ${list}`;
  return [
    `cpg watch benchmark: ${String(total)} saves of ${file}, ${String(spacingMs)} ms apart; trailingMs ${String(trailingMs)}, ceilingMs ${String(ceilingMs)}`,
    `platform: ${platform}; cpu: ${cpu}`,
    metricLine(
      'T0->T3',
      hits.map((h) => h.t0t3),
    ),
    metricLine(
      'latencyMs.total',
      hits.map((h) => h.total),
    ),
    `misses: ${String(misses)} of ${String(total)} (no batch within ${String(MISS_MS)} ms)`,
  ];
}

const DEFAULT_SAVES = 50;
const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSaves(argv) {
  let raw;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--saves') {
      raw = argv[i + 1] ?? '';
      i += 1;
    } else if (arg.startsWith('--saves=')) {
      raw = arg.slice('--saves='.length);
    } else {
      return { ok: false, message: `bench-watch: unknown argument '${arg}'` };
    }
  }
  if (raw === undefined) return { ok: true, saves: DEFAULT_SAVES };
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) {
    return {
      ok: false,
      message: `bench-watch: --saves must be a positive integer, got '${raw}'`,
    };
  }
  return { ok: true, saves: n };
}

async function main(argv) {
  const parsedArgs = parseSaves(argv);
  if (!parsedArgs.ok) {
    console.error(parsedArgs.message);
    return 2;
  }
  const count = parsedArgs.saves;

  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'cli', 'dist', 'main.js');
  if (!existsSync(cli)) {
    console.error(`bench-watch: build first (bun run compile): ${cli} is missing`);
    return 1;
  }

  const ws = await mkdtemp(join(tmpdir(), 'cpg-bench-watch-'));
  let child;
  try {
    await mkdir(join(ws, '.git'));
    await mkdir(join(ws, 'src'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const name = `f${String(i).padStart(2, '0')}.ts`;
        return writeFile(join(ws, 'src', name), `export const f${String(i)} = ${String(i)};\n`);
      }),
    );

    const cfg = spawnSync(process.execPath, [cli, 'config', ws, '--format', 'json'], {
      encoding: 'utf8',
    });
    if (cfg.status !== 0) {
      console.error(`bench-watch: cpg config failed (${String(cfg.status)}): ${cfg.stderr.trim()}`);
      return 1;
    }
    const doc = JSON.parse(cfg.stdout);
    const trailingMs = doc.body.watch.trailingMs.value;
    const ceilingMs = doc.body.watch.ceilingMs.value;

    child = spawn(process.execPath, [cli, 'watch', ws, '--quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const events = [];
    let childStderr = '';
    child.stderr.on('data', (chunk) => {
      childStderr += String(chunk);
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const rlClosed = new Promise((r) => rl.once('close', r));

    let readyEvent;
    let resolveReady;
    const readyPromise = new Promise((r) => {
      resolveReady = r;
    });
    rl.on('line', (line) => {
      if (line.trim() === '') return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      events.push(event);
      if (event?.kind === 'ready' && readyEvent === undefined) {
        readyEvent = event;
        resolveReady?.(event);
      }
    });

    const exitedPromise = new Promise((r) => {
      child.once('close', (code, signal) => r({ code, signal }));
    });

    let readyTimer;
    const readyOutcome = await Promise.race([
      readyPromise.then((event) => ({ kind: 'ready', event })),
      exitedPromise.then((exit) => ({ kind: 'exited', exit })),
      new Promise((r) => {
        readyTimer = setTimeout(() => r({ kind: 'timeout' }), READY_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(readyTimer);

    if (readyOutcome.kind !== 'ready') {
      if (childStderr) process.stderr.write(childStderr);
      console.error(
        readyOutcome.kind === 'timeout'
          ? `bench-watch: timed out waiting for ready event (${String(READY_TIMEOUT_MS)} ms)`
          : `bench-watch: cpg watch exited before ready (${readyOutcome.exit.signal ?? String(readyOutcome.exit.code)})`,
      );
      return 1;
    }

    const spacingMs = 2 * ceilingMs;
    const targetFile = 'src/f00.ts';
    const targetPath = join(ws, targetFile);
    const saves = [];
    /* oxlint-disable no-await-in-loop */
    for (let i = 0; i < count; i += 1) {
      await sleep(spacingMs);
      const t0 = Date.now();
      await writeFile(targetPath, `export const f0 = ${String(1000 + i)};\n`);
      saves.push({ path: targetFile, t0 });
    }
    const lastSave = saves.at(-1);
    if (lastSave !== undefined) {
      const deadline = Date.now() + MISS_MS;
      while (Date.now() < deadline && matchSaves([lastSave], events)[0] === null) {
        await sleep(POLL_MS);
      }
    }
    /* oxlint-enable no-await-in-loop */

    child.kill('SIGINT');
    const exit = await exitedPromise;
    await rlClosed;

    const matches = matchSaves(saves, events);
    const cpuList = cpus();
    const lines = benchLines({
      file: targetFile,
      spacingMs,
      trailingMs,
      ceilingMs,
      consumers: readyOutcome.event.report.consumers,
      platform: `${process.platform} ${release()} ${process.arch}`,
      cpu: `${cpuList[0]?.model || 'unknown'} x ${String(cpuList.length)}`,
      matches,
    });
    for (const line of lines) console.log(line);

    const lastKind = events.at(-1)?.kind;
    if (exit.code === 130 && lastKind === 'closed') {
      console.log('exit: 130 after SIGINT; last event closed');
      return 0;
    }

    if (childStderr) process.stderr.write(childStderr);
    const how = exit.signal !== null ? `signal ${exit.signal}` : `code ${String(exit.code)}`;
    console.error(
      `bench-watch: cpg watch did not end cleanly after SIGINT: ${how}, last event ${String(lastKind ?? 'none')}`,
    );
    return 1;
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await rm(ws, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`bench-watch: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
