// The live picture (U2b.1 part 3b, BMO-35): what `cpg inspect` and `cpg index --inspect` do once
// they hold a payload. The graph goes to the inspector child with its verdict beside it
// (08-verification §3.3), and render-reconciliation is recomputed from each render-report
// (controller decisions 21 and 23).

import {
  renderReconciliation,
  worstState,
  type CheckResult,
  type VerifyCheckId,
} from '@cpg/engine';
import {
  validatePayload,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type VerificationReport,
} from '@cpg/model';
import type { Io } from './io';
import type {
  InspectorExit,
  InspectorProcess,
  RenderReportMessage,
  StartInspector,
} from './inspector-process';

const CHECK_IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];

const MAX_DEFECT_WARNINGS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGraphNode(value: unknown): value is GraphNode {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['type'] === 'string' &&
    (value['name'] === undefined || typeof value['name'] === 'string') &&
    (value['data'] === undefined || isRecord(value['data']))
  );
}

function isGraphEdge(value: unknown): value is GraphEdge {
  return (
    isRecord(value) &&
    typeof value['source'] === 'string' &&
    typeof value['target'] === 'string' &&
    (value['type'] === undefined || typeof value['type'] === 'string') &&
    (value['data'] === undefined || isRecord(value['data']))
  );
}

function isGraphPayload(value: unknown): value is GraphPayload {
  return (
    isRecord(value) &&
    typeof value['seq'] === 'number' &&
    Number.isSafeInteger(value['seq']) &&
    value['seq'] >= -1 &&
    Array.isArray(value['nodes']) &&
    value['nodes'].every(isGraphNode) &&
    Array.isArray(value['edges']) &&
    value['edges'].every(isGraphEdge)
  );
}

function describePayloadDefect(body: unknown): string {
  if (!isRecord(body)) return 'body';
  const seq = body['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < -1) return 'seq';
  const nodes = body['nodes'];
  if (!Array.isArray(nodes)) return 'nodes';
  for (let i = 0; i < nodes.length; i += 1) {
    if (!isGraphNode(nodes[i])) return `nodes[${String(i)}]`;
  }
  const edges = body['edges'];
  if (!Array.isArray(edges)) return 'edges';
  for (let i = 0; i < edges.length; i += 1) {
    if (!isGraphEdge(edges[i])) return `edges[${String(i)}]`;
  }
  return 'shape';
}

function liveVerification(
  checks: readonly CheckResult[],
  render: CheckResult,
): Omit<VerificationReport, 'epoch'> {
  const nextChecks = checks.map((check) => (check.id === 'render-reconciliation' ? render : check));
  const state = worstState(nextChecks.map((check) => check.state));
  const seq = Math.min(...nextChecks.map((check) => check.asOfSeq));
  return { seq, state, checks: nextChecks };
}

function waitForLiveEnd(exited: Promise<InspectorExit>, signal?: AbortSignal): Promise<LiveEnd> {
  if (signal?.aborted === true) {
    return Promise.resolve({ kind: 'interrupted' });
  }
  return new Promise<LiveEnd>((resolve) => {
    let done = false;
    const finish = (end: LiveEnd): void => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(end);
    };
    const onAbort = (): void => {
      finish({ kind: 'interrupted' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void exited.then((exit) => {
      finish(exit.signal === 'SIGINT' ? { kind: 'interrupted' } : { kind: 'exited', exit });
    });
  });
}

/**
 * What an inspector is showing: the payload last sent and its checks, re-judged on each
 * render-report (serveLive and `cpg watch --inspect` share it).
 */
export interface LivePicture {
  /** Pass as the inspector's onRenderReport. A report before the first show(), or after close(), is ignored. */
  readonly onRenderReport: (message: RenderReportMessage) => void;
  /**
   * Sends `{ type: 'graph', payload, cause }`, `cause` being `'initial'` on the first show() and
   * `'catch-up'` after it (decision 84), then a verification (`checks` with render-reconciliation
   * replaced) whose render-reconciliation is judged against `payload` (its seq and node count) from
   * the latest render-report received since the first show(), or none.
   */
  show(proc: InspectorProcess, payload: GraphPayload, checks: readonly CheckResult[]): void;
  /**
   * Sprint 26 (decision 84): merges each delta, in order, into the payload last shown with
   * applyGraphDelta, the inspector's own merge, so render-reconciliation is judged against the
   * picture the inspector holds. Applied: sent as `{ type: 'graph-delta', delta }` to the process
   * last shown. Already-applied: skipped, nothing sent. Returns false, and stops there, on a gap or
   * a malformed delta, or before any show(); true otherwise. Sends no verification. After close():
   * nothing, and true.
   */
  apply(deltas: readonly GraphDelta[]): boolean;
  /**
   * Sends a verification of `checks` for the payload held now, judged as show() judges, and makes
   * them the checks a later render-report re-judges. Before any show() or after close(): nothing.
   */
  reverify(checks: readonly CheckResult[]): void;
  /** After it, show(), apply(), reverify() and render-reports do nothing. */
  close(): void;
}

/**
 * Creates a live picture tracker for one inspector process: `show()` sends a graph and its
 * verification, and `onRenderReport` recomputes render-reconciliation against the payload last
 * shown, re-sending the verification and printing a status line only when the check changes.
 */
export function livePicture(io: Io): LivePicture {
  // REAL
  let closed = false;
  let current:
    | {
        readonly proc: InspectorProcess;
        readonly payload: GraphPayload;
        readonly checks: readonly CheckResult[];
        render: CheckResult;
      }
    | undefined;
  let latest: { readonly seq: number; readonly report: RenderReportMessage['report'] } | null =
    null;

  const onRenderReport = (message: RenderReportMessage): void => {
    if (closed || current === undefined) return;
    latest = { seq: message.seq, report: message.report };
    const next = renderReconciliation({
      payloadSeq: current.payload.seq,
      payloadNodeCount: current.payload.nodes.length,
      latest,
      url: current.proc.url,
    });
    if (JSON.stringify(next) === JSON.stringify(current.render)) return;
    current.render = next;
    io.err(
      `cpg: render-reconciliation ${next.state}${next.detail !== undefined ? `: ${next.detail}` : ''}`,
    );
    current.proc.send({ type: 'verification', report: liveVerification(current.checks, next) });
  };

  return {
    onRenderReport,
    apply(deltas: readonly GraphDelta[]): boolean {
      // SEAT: sprint 26 (decision 84)
      throw new Error(
        `SEAT: LivePicture.apply(${String(deltas.length)} deltas) lands in sprint 26`,
      );
    },
    reverify(checks: readonly CheckResult[]): void {
      // SEAT: sprint 26 (decision 84)
      void checks;
    },
    show(proc: InspectorProcess, payload: GraphPayload, checks: readonly CheckResult[]): void {
      if (closed) return;
      const render = renderReconciliation({
        payloadSeq: payload.seq,
        payloadNodeCount: payload.nodes.length,
        latest,
        url: proc.url,
      });
      current = { proc, payload, checks, render };
      proc.send({ type: 'graph', payload });
      proc.send({ type: 'verification', report: liveVerification(checks, render) });
    },
    close(): void {
      closed = true;
      current = undefined;
    },
  };
}

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
  // REAL
  const { payload, checks, io, signal } = options;
  const picture = livePicture(io);
  const proc = await options.start({ onRenderReport: picture.onRenderReport });
  try {
    if (signal?.aborted === true) {
      return { kind: 'interrupted' };
    }
    io.err(`cpg: inspector at ${proc.url} (open it in a browser; Ctrl-C stops it)`);
    picture.show(proc, payload, checks);
    return await waitForLiveEnd(proc.exited, signal);
  } finally {
    picture.close();
    await proc.stop();
  }
}

/**
 * The six checks for a saved payload (controller decision 22): every one `unavailable` with
 * observed 0, expected 0, no localisedTo, detail `a saved payload has no workspace to check`, and
 * `asOfSeq` the payload's seq. serveLive replaces render-reconciliation.
 */
export function savedPayloadChecks(seq: number): readonly CheckResult[] {
  // REAL
  return CHECK_IDS.map((id) => ({
    id,
    state: 'unavailable',
    observed: 0,
    expected: 0,
    localisedTo: [],
    detail: 'a saved payload has no workspace to check',
    asOfSeq: seq,
  }));
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
  // REAL
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }

  if (
    !isRecord(parsed) ||
    parsed['v'] !== 1 ||
    parsed['kind'] !== 'cpg.graph.payload' ||
    typeof parsed['tool'] !== 'string' ||
    typeof parsed['producedAt'] !== 'string' ||
    !Object.hasOwn(parsed, 'body')
  ) {
    return { ok: false, reason: 'not a cpg.graph.payload document' };
  }

  const body = parsed['body'];
  if (!isGraphPayload(body)) {
    return { ok: false, reason: `the body is not a GraphPayload: ${describePayloadDefect(body)}` };
  }

  const defects = validatePayload(body);
  const warnings = defects
    .slice(0, MAX_DEFECT_WARNINGS)
    .map((defect) => `payload defect ${defect.code}: ${defect.detail}`);
  if (defects.length > MAX_DEFECT_WARNINGS) {
    warnings.push(`and ${String(defects.length - MAX_DEFECT_WARNINGS)} more payload defects`);
  }

  return { ok: true, payload: body, warnings };
}
