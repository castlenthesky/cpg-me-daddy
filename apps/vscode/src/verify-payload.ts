// REAL (U3.1.1 part 2, BMO-52): the six checks of C-EXT's verify, over the host's own payload and a
// FilesystemProbe (controller decision 29). Every verdict is @cpg/engine's, the one definition the
// CLI's verify uses (decision 25); this file only feeds it.

import {
  filesystemReconciliation,
  idUniqueness,
  renderReconciliation,
  revisionReconciliation,
  unavailableCheck,
  worstState,
  type AdmittedPath,
  type AdmittedRevision,
  type GraphFile,
  type GraphRevision,
  type RenderObservation,
} from '@cpg/engine';
import {
  WORKSPACE_ROOT,
  type CheckResult,
  type Epoch,
  type GraphPayload,
  type VerificationReport,
  type WorkspacePath,
} from '@cpg/model';
import type { FilesystemProbe } from './contract';
import { serializeError } from './errors';

/** What verify judges, read from the host before its first await (C-EXT I-18). */
export interface VerifySubject {
  readonly payload: GraphPayload;
  readonly epoch: Epoch;
  /** The latest accepted render-report, or null: the page now showing has reported nothing. */
  readonly latest: RenderObservation | null;
}

/** How many digests run at the same time, so a large workspace is not read all at once. */
const DIGESTS_AT_ONCE = 32;

function admittedPath({ path }: { readonly path: string }): AdmittedPath {
  const slash = path.lastIndexOf('/');
  return { path, parent: slash === -1 ? WORKSPACE_ROOT : path.slice(0, slash) };
}

/** What the probe answered, or the detail of the checks it feeds. */
type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; detail: string };

async function ask<T>(question: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await question() };
  } catch (thrown) {
    const { name, message } = serializeError(thrown);
    return { ok: false, detail: `the filesystem probe failed: ${name}: ${message}` };
  }
}

/** The paths that have a digest, with it. */
async function digestAll(
  paths: readonly WorkspacePath[],
  fs: FilesystemProbe,
): Promise<readonly AdmittedRevision[]> {
  const digested: AdmittedRevision[] = [];
  for (let start = 0; start < paths.length; start += DIGESTS_AT_ONCE) {
    const batch = paths.slice(start, start + DIGESTS_AT_ONCE).map(async (path) => {
      const revision_id = await fs.digest(path);
      if (revision_id !== undefined) digested.push({ path, revision_id });
    });
    await Promise.all(batch); // oxlint-disable-line no-await-in-loop -- one batch at a time
  }
  return digested;
}

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
  subject: VerifySubject,
  fs: FilesystemProbe,
): Promise<VerificationReport> {
  const { payload, epoch, latest } = subject;
  const asOfSeq = payload.seq;

  const graphFiles: GraphRevision[] = [];
  const fileRevisions = new Map<string, string>();
  for (const node of payload.nodes) {
    if (node.type !== 'FILE') continue;
    const path = node.data?.['path'];
    const rev = node.data?.['revision_id'];
    graphFiles.push({
      file: typeof path === 'string' ? path : node.id,
      revision_id: typeof rev === 'string' ? rev : '',
    });
    if (typeof path === 'string' && typeof rev === 'string') {
      fileRevisions.set(path, rev);
    }
  }

  const staleNodes: GraphFile[] = [];
  for (const node of payload.nodes) {
    const file = node.data?.['file'];
    const nodeRev = node.data?.['revision_id'];
    if (typeof file !== 'string' || typeof nodeRev !== 'string') continue;
    const fileRev = fileRevisions.get(file);
    if (fileRev !== undefined && nodeRev !== fileRev) {
      staleNodes.push({ file });
    }
  }

  const listed = await ask(async () => [...new Set(await fs.listFiles())]);
  const digested = listed.ok ? await ask(() => digestAll(listed.value, fs)) : listed;

  const checks: readonly CheckResult[] = [
    listed.ok
      ? filesystemReconciliation(
          (digested.ok ? digested.value : listed.value.map((path) => ({ path }))).map(admittedPath),
          graphFiles,
          asOfSeq,
        )
      : unavailableCheck('filesystem-reconciliation', asOfSeq, listed.detail),
    // SEAT: identity-invariants and resolution-health are computed from U6c, as in engine.verify.
    unavailableCheck(
      'identity-invariants',
      asOfSeq,
      'identity-invariants is computed from U6c (no code tier yet)',
    ),
    idUniqueness([payload.nodes.map((node) => node.id)], asOfSeq),
    renderReconciliation({
      payloadSeq: asOfSeq,
      payloadNodeCount: payload.nodes.length,
      latest,
      url: 'the graph panel (CPG: Open Graph)',
    }),
    digested.ok
      ? revisionReconciliation(digested.value, graphFiles, staleNodes, asOfSeq)
      : unavailableCheck('revision-reconciliation', asOfSeq, digested.detail),
    unavailableCheck(
      'resolution-health',
      asOfSeq,
      'resolution-health is computed from U6c (no ResolveReport yet)',
    ),
  ];

  return {
    epoch,
    seq: asOfSeq,
    checks,
    state: worstState(checks.map((check) => check.state)),
  };
}
