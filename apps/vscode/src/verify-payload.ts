// SEAT (U3.1.1 part 2, BMO-52): the six checks of C-EXT's verify, over the host's own payload and a
// FilesystemProbe (controller decision 29). Every verdict is @cpg/engine's, the one definition the
// CLI's verify uses (decision 25); this file only feeds it.

import type { RenderObservation } from '@cpg/engine';
import type { Epoch, GraphPayload, VerificationReport } from '@cpg/model';
import type { FilesystemProbe } from './contract';

/** What verify judges, read from the host before its first await (C-EXT I-18). */
export interface VerifySubject {
  readonly payload: GraphPayload;
  readonly epoch: Epoch;
  /** The latest accepted render-report, or null: the page now showing has reported nothing. */
  readonly latest: RenderObservation | null;
}

/** How many digests run at the same time, so a large workspace is not read all at once. */
export const DIGESTS_AT_ONCE = 32;

/**
 * All six checks, once each, in enum order (I-18), each with `asOfSeq` the payload's seq; the report
 * carries that seq and the subject's epoch, whatever happens to the host meanwhile. `state` is their
 * worst (worstState). Never rejects.
 *
 * - filesystem-reconciliation: the admitted files against the payload's FILE nodes, per directory. A
 *   file is admitted when listFiles names it (repeats count once, stop-list 84) and it has a digest:
 *   the walker admits only what it can read. A FILE's path is its `path` property, or its id when
 *   that is not a string, so a FILE with no path is an offender rather than dropped.
 * - identity-invariants, resolution-health: `unavailable` until U6c, with the engine's wording.
 * - id-uniqueness: over every payload node id, as one list (I-10).
 * - render-reconciliation: the latest render-report against the payload's own node count (I-10, I-19;
 *   decision 25). With no report it is `unavailable`, detail
 *   `no render-report yet: open the graph panel (CPG: Open Graph)`.
 * - revision-reconciliation: each admitted file's digest against its FILE's `revision_id` (a FILE with
 *   none never matches), plus every node whose `revision_id` differs from that of the FILE its `file`
 *   property names.
 *
 * A probe that throws or rejects makes what it feeds `unavailable`, never pass, with
 * `the filesystem probe failed: <name>: <message>` in `detail`: listFiles feeds both disk checks,
 * digest only revision-reconciliation (the listing alone then decides what is admitted). At most
 * DIGESTS_AT_ONCE digests are in flight, and each distinct path is asked for once.
 */
export async function verifyPayload(
  _subject: VerifySubject,
  _fs: FilesystemProbe,
): Promise<VerificationReport> {
  throw new Error('SEAT: verifyPayload lands with U3.1.1 part 2');
}
