// REAL (U2b.1 part 3a-i, BMO-35): the page's typed boundary for host messages. C-EXT may_not "type
// the webview boundary loosely": the parser returns a well-formed message or undefined, never a cast.
// REAL (U2b.1 part 3a-ii, BMO-35): the inspector process's two boundaries, page -> host
// (parseWebviewMessage) and stdin -> host (parseInspectorInput).

import {
  CPG_PROTOCOL_VERSION,
  type CheckResult,
  type CheckState,
  type GraphDelta,
  type GraphPayload,
  type HostToWebview,
  type RenderReport,
  type VerificationReport,
  type VerifyCheckId,
  type WebviewToHost,
} from '@cpg/model';

/** The host messages the page acts on; `theme` is not among them yet (controller decision 14). */
export type PageMessage = Extract<
  HostToWebview,
  { type: 'graph' | 'graph-delta' | 'verification' }
>;

const CHECK_STATES: readonly CheckState[] = ['pass', 'fail', 'stale', 'unavailable'];
const CHECK_STATE_SET = new Set<unknown>(CHECK_STATES);

const CHECK_IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];
const CHECK_ID_SET = new Set<unknown>(CHECK_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isGraphPayload(value: unknown): value is GraphPayload {
  return (
    isRecord(value) &&
    typeof value['seq'] === 'number' &&
    isArray(value['nodes']) &&
    isArray(value['edges'])
  );
}

function isGraphDelta(value: unknown): value is GraphDelta {
  return (
    isRecord(value) &&
    typeof value['seq'] === 'number' &&
    typeof value['file'] === 'string' &&
    typeof value['revision_id'] === 'string' &&
    (value['producer'] === 'filesystem' || value['producer'] === 'code') &&
    isArray(value['addedNodes']) &&
    isArray(value['addedEdges']) &&
    isArray(value['removedNodeIds'])
  );
}

function isCheckResult(value: unknown): value is CheckResult {
  return (
    isRecord(value) &&
    CHECK_ID_SET.has(value['id']) &&
    CHECK_STATE_SET.has(value['state']) &&
    typeof value['observed'] === 'number' &&
    typeof value['expected'] === 'number' &&
    typeof value['asOfSeq'] === 'number' &&
    isArray(value['localisedTo']) &&
    value['localisedTo'].every((entry) => typeof entry === 'string') &&
    (value['detail'] === undefined || typeof value['detail'] === 'string')
  );
}

function isVerificationReport(value: unknown): value is VerificationReport {
  return (
    isRecord(value) &&
    typeof value['epoch'] === 'number' &&
    typeof value['seq'] === 'number' &&
    CHECK_STATE_SET.has(value['state']) &&
    isArray(value['checks']) &&
    value['checks'].every(isCheckResult)
  );
}

function isPageMessage(value: unknown): value is PageMessage {
  if (!isRecord(value)) return false;
  if (
    value['protocol'] !== CPG_PROTOCOL_VERSION ||
    typeof value['epoch'] !== 'number' ||
    typeof value['seq'] !== 'number'
  ) {
    return false;
  }
  switch (value['type']) {
    case 'graph':
      return isGraphPayload(value['payload']);
    case 'graph-delta':
      return isGraphDelta(value['delta']);
    case 'verification':
      return isVerificationReport(value['report']);
    default:
      return false;
  }
}

/**
 * A `graph`, `graph-delta` or `verification` message at protocol 1 whose every field has its
 * contract type (node and edge fields are not checked, stop-list 55), or undefined. Never throws.
 */
export function parsePageMessage(value: unknown): PageMessage | undefined {
  return isPageMessage(value) ? value : undefined;
}

/**
 * One NDJSON line on the inspector's stdin (owner decision 9a): a payload, a delta or a verify
 * report. The host assigns `protocol` and `epoch` itself, so the line carries neither.
 */
export type InspectorInput =
  | { readonly type: 'graph'; readonly payload: GraphPayload }
  | { readonly type: 'graph-delta'; readonly delta: GraphDelta }
  | { readonly type: 'verification'; readonly report: Omit<VerificationReport, 'epoch'> };

const RESYNC_REASONS: readonly ('gap' | 'stale-epoch' | 'render-error')[] = [
  'gap',
  'stale-epoch',
  'render-error',
];
const RESYNC_REASON_SET = new Set<unknown>(RESYNC_REASONS);

function isRenderReport(value: unknown): value is RenderReport {
  return (
    isRecord(value) &&
    typeof value['payloadNodeCount'] === 'number' &&
    typeof value['renderedNodeCount'] === 'number' &&
    typeof value['renderedEdgeCount'] === 'number' &&
    typeof value['duplicateEdges'] === 'number' &&
    isArray(value['droppedNodeIds']) &&
    value['droppedNodeIds'].every((entry) => typeof entry === 'string') &&
    typeof value['frameMs'] === 'number'
  );
}

function isWebviewMessage(value: unknown): value is WebviewToHost {
  if (!isRecord(value)) return false;
  switch (value['type']) {
    case 'ready':
      return typeof value['protocol'] === 'number';
    case 'reveal':
      return typeof value['nodeId'] === 'string';
    case 'resync':
      return (
        typeof value['epoch'] === 'number' &&
        typeof value['seq'] === 'number' &&
        RESYNC_REASON_SET.has(value['reason'])
      );
    case 'render-report':
      return (
        typeof value['epoch'] === 'number' &&
        typeof value['seq'] === 'number' &&
        isRenderReport(value['report'])
      );
    default:
      return false;
  }
}

/**
 * A `ready` (any numeric protocol: the host decides), `reveal`, `resync` or `render-report` whose
 * every field has its C-EXT type, or undefined. Never throws.
 */
export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
  return isWebviewMessage(value) ? value : undefined;
}

function isVerificationInputReport(value: unknown): value is Omit<VerificationReport, 'epoch'> {
  return (
    isRecord(value) &&
    typeof value['seq'] === 'number' &&
    CHECK_STATE_SET.has(value['state']) &&
    isArray(value['checks']) &&
    value['checks'].length === CHECK_IDS.length &&
    value['checks'].every((entry, index) => isCheckResult(entry) && entry.id === CHECK_IDS[index])
  );
}

function isInspectorInput(value: unknown): value is InspectorInput {
  if (!isRecord(value)) return false;
  switch (value['type']) {
    case 'graph':
      return isGraphPayload(value['payload']);
    case 'graph-delta':
      return isGraphDelta(value['delta']);
    case 'verification':
      return isVerificationInputReport(value['report']);
    default:
      return false;
  }
}

/**
 * A stdin line (already JSON-parsed) in one of InspectorInput's three shapes, or undefined. A
 * verification must carry all six checks, once each, in enum order (C-EXT I-18), since the host
 * posts it as a VerificationReport. Node and edge fields are not checked (stop-list 55). Never throws.
 */
export function parseInspectorInput(value: unknown): InspectorInput | undefined {
  return isInspectorInput(value) ? value : undefined;
}
