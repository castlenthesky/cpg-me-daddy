// C-WATCH layer B's session, part a (U4.1.2, BMO-51). SEAT until the implementation lands.
// Ported from e45574f:packages/engine/src/watch/watch-workspace.ts, without its initial walk, its
// matcher and its fs reads: the disk comes in as the injected WatchProbe (INV-3, decision 47) and
// admission as `admit`. Part b (sprint 21) adds the initial walk, the subtree walk on a directory
// create (INV-5) and the backend's errors (INV-25); until then every batch is `cause: 'live'` and
// backend errors are not handled here.

import type { WatchSession, WatchSessionOptions } from './contract';

/**
 * Subscribes `options.backend` to `options.root` and turns each settled window of raw events into
 * at most one `ChangeBatch` for `options.sink`. Rejects, with the backend's own error, when
 * subscribe rejects.
 *
 * Per window, in one SerialQueue job (at most one in flight, INV-21):
 * - `clock.settledAt` is `now()` as the job starts; `clock.firstEventAt` is the smallest `observedAt`
 *   among the window's raw events.
 * - Each raw path (and a moved's `fromPath`) maps through `toWorkspacePath(root, path)`; one that
 *   throws, and the root itself, is dropped (INV-4, INV-23). A raw moved is taken as a deleted of
 *   its source plus a created of its path; pairing restores the move (native moves are BMO-131's).
 * - A deleted is a `'directory'` when its path is a known directory, else a `'file'`. A created or
 *   changed is classified by `probe.stat` (`undefined`: dropped), then admitted, then a file is
 *   digested by `probe.digest` (`undefined`: dropped) into `revision_id`, with `sizeBytes` from the
 *   stat; a directory carries neither. Each file is digested at most once per window (INV-26).
 * - `admit(path, entry, sizeBytes?)` runs on every event, deletes included; a refused path never
 *   reaches coalesce. The default admits everything.
 * - The changes fold through `coalesce` into a fresh pending map, then `flushBatch` and
 *   `pairFileRenames` against the known revisions.
 * - Kind rules (decision 49): a file created or changed is `created` on an unknown path, `changed` on
 *   a known one, and dropped when its revision equals the known one. A directory created or changed
 *   is `created` when unknown and dropped when known. The result is in flushBatch order (INV-16).
 * - An empty batch is not delivered and takes no seq. Otherwise the batch (`cause: 'live'`, the next
 *   seq, from 0) goes to `sink.onBatch` through `withRetry` with its default bounds and the session's
 *   timers.
 *
 * Confirmed delivery advances the seq by one and the known state, in batch order: a created or
 * changed file records its revision, a created directory is known, a deleted file is forgotten, a
 * deleted directory forgets its whole subtree, a moved moves the revision from `fromPath` to `path`.
 * When the retries are exhausted, `onDegraded` gets every path in the batch (`fromPath` included) and
 * the last rejection unchanged; nothing advances and the seq is reused (INV-20, INV-22). A probe or
 * `admit` that throws also reaches `onDegraded`, with every workspace path the window's raw events
 * named.
 *
 * `close()` is idempotent and resolves after the subscription's own close. From the call on, no
 * `sink.onBatch` call starts (a retry wakes and returns), `onDegraded` never fires, and the open
 * window and queued windows are dropped (OQ-3). It does not wait for a sink call in flight.
 */
export function createWatchSession(_options: WatchSessionOptions): Promise<WatchSession> {
  // SEAT
  return Promise.reject(new Error('SEAT: createWatchSession lands in U4.1.2 part a (BMO-51)'));
}
