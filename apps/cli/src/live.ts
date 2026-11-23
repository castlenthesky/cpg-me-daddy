// The live picture (U2b.1 part 3b, BMO-35): what `cpg inspect` and `cpg index --inspect` do once
// they hold a payload. The graph goes to the inspector child with its verdict beside it
// (08-verification §3.3), and render-reconciliation is recomputed from each render-report
// (controller decisions 21 and 23).

import type { CheckResult } from '@cpg/engine';
import type { GraphPayload } from '@cpg/model';
import type { Io } from './io';
import type { InspectorExit, StartInspector } from './inspector-process';

/** Why the live loop ended: the signal aborted, or the child exited on its own. */
export type LiveEnd =
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'exited'; readonly exit: InspectorExit };

export interface LiveOptions {
  readonly payload: GraphPayload;
  /** All six checks in enum order. Render-reconciliation is replaced by the one computed here. */
  readonly checks: readonly CheckResult[];
  readonly start: StartInspector;
  readonly io: Io;
  readonly signal?: AbortSignal;
}

/**
 * Starts the inspector and prints `cpg: inspector at <url> (open it in a browser; Ctrl-C stops it)`
 * on stderr. It sends the `graph`, then a `verification` with render-reconciliation `unavailable`
 * (renderReconciliation with no report). Each render-report recomputes the check. When the check
 * differs from the last one sent, it sends a new `verification` and prints
 * `cpg: render-reconciliation <state>` (`: <detail>` when there is one).
 *
 * A verification's checks are `checks` with render-reconciliation replaced. Its state is their
 * worst, and its seq is their lowest `asOfSeq` (controller decision 23).
 *
 * Resolves `interrupted` when the signal aborts, or when the child exits on SIGINT (Ctrl-C reaches
 * the whole process group). Any other exit resolves `exited`. The child is stopped before it
 * resolves. Rejects only when `start` rejects.
 */
export async function serveLive(options: LiveOptions): Promise<LiveEnd> {
  // SEAT: U2b.1 part 3b
  throw new Error(`SEAT: serveLive at seq ${String(options.payload.seq)} (U2b.1 part 3b)`);
}

/**
 * The six checks for a saved payload (controller decision 22): every one `unavailable` with
 * observed 0, expected 0, no localisedTo, detail `a saved payload has no workspace to check`, and
 * `asOfSeq` the payload's seq. serveLive replaces render-reconciliation.
 */
export function savedPayloadChecks(seq: number): readonly CheckResult[] {
  // SEAT: U2b.1 part 3b
  throw new Error(`SEAT: savedPayloadChecks at seq ${String(seq)} (U2b.1 part 3b)`);
}

export type PayloadParse =
  | { readonly ok: true; readonly payload: GraphPayload; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A saved `cpg.graph.payload` document (C-CLI Document), checked at the boundary. The reason is
 * `not JSON`, `not a cpg.graph.payload document` (the envelope is not `v` 1, that kind, string
 * `tool` and `producedAt`, and a `body`), or `the body is not a GraphPayload: <what>`. The body must
 * have a safe-integer `seq` ≥ -1, `nodes` of `{ id, type }` strings with an optional string `name`
 * and object `data`, and `edges` of `{ source, target }` strings with an optional string `type` and
 * object `data`. `validatePayload`'s defects do not refuse it. Each becomes a warning,
 * `payload defect <code>: <detail>`, up to 10, then `and <n> more payload defects`, so a duplicate
 * id reaches the picture and fails render-reconciliation there (C-EXT I-10).
 */
export function parsePayloadDocument(text: string): PayloadParse {
  // SEAT: U2b.1 part 3b
  throw new Error(`SEAT: parsePayloadDocument of ${String(text.length)} chars (U2b.1 part 3b)`);
}
