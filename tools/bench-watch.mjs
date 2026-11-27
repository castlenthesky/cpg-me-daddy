#!/usr/bin/env node
// SEAT (U4.2.1 part b, BMO-60; controller decision 68): the T0 -> T3 benchmark of `cpg watch`, run by
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
export function matchSaves(_saves, _events, _missMs = MISS_MS) {
  // SEAT
  throw new Error('SEAT: matchSaves (U4.2.1 part b)');
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
export function benchLines(_run) {
  // SEAT
  throw new Error('SEAT: benchLines (U4.2.1 part b)');
}
