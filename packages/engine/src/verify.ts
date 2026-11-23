// cpg verify's six checks (C-CLI VerifyReport, 08-verification.md §3, BMO-80).

import { NODE_LABELS, WORKSPACE_ROOT, type RenderReport } from '@cpg/model';
import type { GraphSink } from '@cpg/sink';
import type { FileState, GraphStore, StaleNode } from '@cpg/store';
import type { CheckResult, CheckState, VerifyCheckId, VerifyConfig, VerifyReport } from './port';
import { walkWorkspace, type WalkedFile } from './walker/walker';

type StoreSink = GraphSink & GraphStore;

const STATE_RANK: Readonly<Record<CheckState, number>> = {
  pass: 0,
  unavailable: 1,
  stale: 2,
  fail: 3,
};

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function distinctSorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].toSorted(compareCodeUnits);
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? WORKSPACE_ROOT : path.slice(0, slash);
}

function unavailableCheck(id: VerifyCheckId, asOfSeq: number, detail: string): CheckResult {
  return {
    id,
    state: 'unavailable',
    observed: 0,
    expected: 0,
    localisedTo: [],
    detail,
    asOfSeq,
  };
}

function applyStrict(check: CheckResult, strict: boolean): CheckResult {
  if (!strict || check.state !== 'unavailable') return check;
  const suffix = '--strict counts unavailable as a failure';
  const detail = check.detail !== undefined ? `${check.detail}; ${suffix}` : suffix;
  return { ...check, state: 'fail', detail };
}

function checkFilesystemReconciliation(
  admittedFiles: readonly WalkedFile[],
  fileStates: readonly FileState[],
  asOfSeq: number,
): CheckResult {
  const admittedByDir = new Map<string, Set<string>>();
  for (const file of admittedFiles) {
    let set = admittedByDir.get(file.parent);
    if (set === undefined) {
      set = new Set<string>();
      admittedByDir.set(file.parent, set);
    }
    set.add(file.path);
  }

  const storedByDir = new Map<string, Set<string>>();
  const storedPaths = new Set<string>();
  for (const state of fileStates) {
    storedPaths.add(state.file);
    const dir = parentDir(state.file);
    let set = storedByDir.get(dir);
    if (set === undefined) {
      set = new Set<string>();
      storedByDir.set(dir, set);
    }
    set.add(state.file);
  }

  const allDirs = new Set<string>([...admittedByDir.keys(), ...storedByDir.keys()]);
  const offenders: string[] = [];
  let missing = 0;
  let extra = 0;

  for (const dir of allDirs) {
    const expectedSet = admittedByDir.get(dir);
    const observedSet = storedByDir.get(dir);
    let missingHere = 0;
    let extraHere = 0;

    if (expectedSet !== undefined) {
      for (const path of expectedSet) {
        if (observedSet === undefined || !observedSet.has(path)) {
          missingHere += 1;
        }
      }
    }
    if (observedSet !== undefined) {
      for (const path of observedSet) {
        if (expectedSet === undefined || !expectedSet.has(path)) {
          extraHere += 1;
        }
      }
    }

    if (missingHere > 0 || extraHere > 0) {
      offenders.push(dir);
      missing += missingHere;
      extra += extraHere;
    }
  }

  const localisedTo = distinctSorted(offenders);
  const failed = localisedTo.length > 0;
  return {
    id: 'filesystem-reconciliation',
    state: failed ? 'fail' : 'pass',
    observed: storedPaths.size,
    expected: admittedFiles.length,
    localisedTo,
    ...(failed ? { detail: `${missing} missing, ${extra} extra` } : {}),
    asOfSeq,
  };
}

function checkIdUniqueness(keyLists: readonly (readonly string[])[], asOfSeq: number): CheckResult {
  let observed = 0;
  let expected = 0;
  const duplicates = new Set<string>();

  for (const keys of keyLists) {
    observed += keys.length;
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) {
        duplicates.add(key);
      } else {
        seen.add(key);
      }
    }
    expected += seen.size;
  }

  const localisedTo = distinctSorted(duplicates);
  const failed = localisedTo.length > 0;
  return {
    id: 'id-uniqueness',
    state: failed ? 'fail' : 'pass',
    observed,
    expected,
    localisedTo,
    ...(failed
      ? { detail: `${observed - expected} duplicate ${observed - expected === 1 ? 'key' : 'keys'}` }
      : {}),
    asOfSeq,
  };
}

function checkRevisionReconciliation(
  admittedFiles: readonly WalkedFile[],
  fileStates: readonly FileState[],
  staleNodes: readonly StaleNode[],
  asOfSeq: number,
): CheckResult {
  const admittedRevByPath = new Map<string, string>();
  for (const file of admittedFiles) {
    admittedRevByPath.set(file.path, file.revision_id);
  }

  let mismatches = 0;
  const offendingFiles = new Set<string>();

  for (const state of fileStates) {
    const diskRev = admittedRevByPath.get(state.file);
    if (diskRev !== undefined && state.revision_id !== diskRev) {
      mismatches += 1;
      offendingFiles.add(state.file);
    }
  }

  for (const row of staleNodes) {
    mismatches += 1;
    offendingFiles.add(row.file);
  }

  const localisedTo = distinctSorted(offendingFiles);
  const failed = mismatches > 0;
  return {
    id: 'revision-reconciliation',
    state: failed ? 'fail' : 'pass',
    observed: mismatches,
    expected: 0,
    localisedTo,
    ...(failed
      ? { detail: `${mismatches} revision ${mismatches === 1 ? 'mismatch' : 'mismatches'}` }
      : {}),
    asOfSeq,
  };
}

/** The worst of `states`: fail > stale > unavailable > pass; `pass` when empty. */
export function worstState(states: readonly CheckState[]): CheckState {
  // REAL
  let worst: CheckState = 'pass';
  for (const state of states) {
    if (STATE_RANK[state] > STATE_RANK[worst]) {
      worst = state;
    }
  }
  return worst;
}

/** The latest render-report the page sent, as the front door saw it (the message's seq and body). */
export interface RenderObservation {
  readonly seq: number;
  readonly report: RenderReport;
}

export interface RenderReconciliationInput {
  /** The seq of the payload the renderer was sent: the check's `asOfSeq`. */
  readonly payloadSeq: number;
  /** The latest render-report, or null before the page has sent one. */
  readonly latest: RenderObservation | null;
  /** Where the picture is served. The `unavailable` detail names it, so the human knows what to open. */
  readonly url: string;
}

/**
 * render-reconciliation from the renderer's render-report (08-verification §3.1, C-EXT I-10, I-19;
 * controller decision 21). Pure and I/O-free: the front door that runs the renderer calls it with
 * the latest report. `asOfSeq` is `payloadSeq`.
 *
 * - No report: `unavailable`, observed 0, expected 0, detail `no render-report yet: open <url>`.
 * - `latest.seq < payloadSeq`: `stale` (never pass at a lagging seq), no localisedTo, detail
 *   `render-report at seq <r> lags the payload's seq <p>`. A later seq is judged, not stale.
 * - Otherwise `pass` iff `renderedNodeCount === payloadNodeCount` and `droppedNodeIds` is empty,
 *   else `fail`, with the dropped ids (distinct, sorted) in `localisedTo` and
 *   `<rendered> of <payload> payload nodes drawn` in `detail`.
 *
 * With a report, `observed` is `renderedNodeCount` and `expected` is `payloadNodeCount`.
 * `duplicateEdges > 0` adds `<n> duplicate edge(s) drawn once` to `detail` and never changes the
 * state (owner decision 12a: visible, not silent).
 */
export function renderReconciliation(input: RenderReconciliationInput): CheckResult {
  // SEAT: U2b.1 part 3b
  throw new Error(`SEAT: renderReconciliation at seq ${String(input.payloadSeq)} (U2b.1 part 3b)`);
}

/** Internal to @cpg/engine: runs verify's six read-only checks against one store. */
export async function verifyStore(
  store: StoreSink,
  config: VerifyConfig,
  languageOf: (path: string) => string | undefined,
): Promise<VerifyReport> {
  // REAL
  const start = performance.now();
  const asOfSeq = (await store.inspect()).highWaterSeq;

  const [walkResult, fileStates, keyLists, staleNodes] = await Promise.all([
    walkWorkspace({
      root: config.root,
      languageOf,
      ...(config.include !== undefined ? { include: config.include } : {}),
      ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
      ...(config.maxFileSizeBytes !== undefined
        ? { maxFileSizeBytes: config.maxFileSizeBytes }
        : {}),
    }),
    store.fileStates(),
    Promise.all(NODE_LABELS.map((spec) => store.nodeKeys(spec.label))),
    store.staleNodes(),
  ]);

  const fsCheck = checkFilesystemReconciliation(walkResult.files, fileStates, asOfSeq);
  const idUniquenessCheck = checkIdUniqueness(keyLists, asOfSeq);
  const revisionCheck = checkRevisionReconciliation(
    walkResult.files,
    fileStates,
    staleNodes,
    asOfSeq,
  );

  const rawChecks: readonly CheckResult[] = [
    fsCheck,
    // SEAT: identity-invariants is computed from U6c (no code tier yet).
    unavailableCheck(
      'identity-invariants',
      asOfSeq,
      'identity-invariants is computed from U6c (no code tier yet)',
    ),
    idUniquenessCheck,
    // SEAT: every runnable switch set is headless because connect refuses inspect (U2b) and vscode (U3).
    unavailableCheck('render-reconciliation', asOfSeq, 'no renderer consumer is enabled (ND-8)'),
    revisionCheck,
    // SEAT: resolution-health is computed from U6c (no ResolveReport yet).
    unavailableCheck(
      'resolution-health',
      asOfSeq,
      'resolution-health is computed from U6c (no ResolveReport yet)',
    ),
  ];

  const strict = config.strict === true;
  const checks = rawChecks.map((check) => applyStrict(check, strict));
  const state = worstState(checks.map((check) => check.state));

  return {
    state,
    checks,
    consumers: [store.id],
    durationMs: performance.now() - start,
  };
}
