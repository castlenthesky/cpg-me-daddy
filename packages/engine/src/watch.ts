// CpgEngine.watch (U4.2.1 part a, BMO-60; controller decisions 59-63): index, then a @cpg/watch
// session seeded from the walk, each batch written as one merge-filesystem op, and the C-CLI
// WatchEvent stream. The CLI verb is part b.

import type { WriteOp, WriteReceipt } from '@cpg/store';
import type { NormalizedChange, TimerApi, WatchBackend } from '@cpg/watch';
import type { IndexProgress, IndexReport, IndexRequest, WatchEvent, WatchRequest } from './port';
import type { WalkResult } from './walker/walker';

/** What `index()` computed: its report, and the walk it wrote. */
export interface IndexRun {
  readonly report: IndexReport;
  readonly walk: WalkResult;
}

/** What `runWatch` takes from createEngine. */
export interface WatchDeps {
  /** `index()`'s own code (decision 60): the walk, the one op through every sink, the report. */
  readonly runIndex: (
    req: IndexRequest,
    onProgress: (progress: IndexProgress) => void,
    signal: AbortSignal,
  ) => Promise<IndexRun>;
  /** `index()`'s write: every sink in order, one after another; resolves with the first's receipt. */
  readonly write: (op: WriteOp) => Promise<WriteReceipt>;
  /** The registry's language for a path, as the walk uses it. */
  readonly languageOf: (path: string) => string | undefined;
  readonly backend: WatchBackend;
  /** The one clock: `WatchEvent.at`, the session's `clock.settledAt`, and the write's end (T3). */
  readonly now: () => number;
  /** The session's timers (debounce, retry backoff). Default: the global ones. */
  readonly timers?: TimerApi;
}

/**
 * One batch's changes as ONE merge-filesystem op (decision 62), with filesystemTier's row shapes:
 * - a created or changed file: a FILE row `{ path, name, language, content_hash, revision_id }`
 *   (`language` from `languageOf`, else null; both hashes the change's `revision_id`), plus a
 *   HAS_ENTRY link from its parent DIRECTORY (`'.'` for a top-level path);
 * - a created or changed directory: a DIRECTORY row `{ path, name, status: 'ready' }` plus its link;
 * - a deleted path: a removal of `path` (a directory removes its subtree in the store);
 * - a moved: a removal of `fromPath`, plus the row and link at `path` for its entry.
 * Node ids derive from the path, so a move is a remove and an add (C-WATCH OQ-8); `moves` is
 * always `[]`. Rows, links and removals keep the batch's order. A file change with no
 * `revision_id` throws (C-WATCH INV-26: the session mints one for every file it delivers).
 */
export function toBatchOp(
  _changes: readonly NormalizedChange[],
  _languageOf: (path: string) => string | undefined,
): WriteOp {
  // SEAT: U4.2.1 part a
  throw new Error('SEAT: toBatchOp lands with U4.2.1 part a');
}

/**
 * CpgEngine.watch. Resolves after `closed`, never rejects, and emits nothing after `closed`.
 *
 * Start (decision 60):
 * 1. `runIndex({ config: req.config, session: req.session, resumeFrom: null }, ...)`. If it throws:
 *    `error { engine-rejected }`, then `closed { reason: 'error' }`. If `signal` has aborted by the
 *    time it returns: `closed { reason: 'signal' }`, and no session is created.
 * 2. `createWatchSession` over `req.config.root` with `deps.backend`, the node probe
 *    (`createWatchProbe`, entering only directories the admission admits), `admit` = the walker's
 *    `createAdmission(req.config).admits`, with a path the probe last saw as a symlink passed as
 *    `'symlink'`, `seed` = the walk's files (path -> revision_id, every walked file) and directories
 *    (every walked directory but `'.'`), `trailingMs`/`ceilingMs` when given, `now`, `timers`.
 * 3. A rejected `createWatchSession`: `error` (a WatchError-shaped rejection, such as root-missing,
 *    is `workspace`; anything else `engine-rejected`), then `closed { reason: 'error' }`.
 *
 * The sink (decisions 62, 63): each batch with changes is written once through `deps.write`
 * (`toBatchOp`), and the batch is acknowledged only after that resolves, so known state advances
 * only on confirmed writes (C-SINK INV-19); an empty batch is not written. Then, with `at = now()`:
 * - the initial batch emits `ready { root: req.config.root, report }`, the first event (seq 0);
 * - every other batch emits `batch { changes, write: { nodesWritten, edgesWritten, statementCount }
 *   of the receipt, latencyMs: { t0_t1: null, t1_t2: settledAt - firstEventAt, t2_t3: at -
 *   settledAt, total: t1_t2 + t2_t3 } }`.
 * A throw from `onEvent` is contained: it never rejects the batch (that would rewrite it).
 *
 * Warnings and errors (decision 63): `onDegraded(paths, error)` is a `warning` whose message names
 * every path; a non-fatal backend error is a `warning` whose message starts with its code. A
 * warning that arrives before `ready` is held and emitted right after it, so `ready` is seq 0. A
 * fatal backend error is `error { workspace }`, then `closed { reason: 'error' }`, once the session
 * has closed; its rejection of a start in progress is not reported twice.
 *
 * Stop: `signal` aborting closes the session, then `closed { reason: 'signal' }`. Once a stop has
 * begun (abort, or a fatal error), only `closed` follows: no `ready`, `batch` or `warning`, and a
 * write still in flight is not awaited (a hung sink must not hang the stop; decision 51).
 */
export async function runWatch(
  _deps: WatchDeps,
  _req: WatchRequest,
  _onEvent: (event: WatchEvent) => void,
  _signal: AbortSignal,
): Promise<void> {
  // SEAT: U4.2.1 part a
  throw new Error('SEAT: CpgEngine.watch lands with U4.2.1 part a');
}
