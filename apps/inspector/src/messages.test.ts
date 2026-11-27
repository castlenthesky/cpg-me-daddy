// The inspector's typed boundaries (C-EXT may_not "type the webview boundary loosely"), one parser per
// way a message enters: host -> page (parsePageMessage), page -> host (parseWebviewMessage) and
// stdin -> host (parseInspectorInput, owner decision 9a). Each returns the message when every field
// its receiver reads has its contract type, and undefined otherwise; it never throws. Shapes are
// C-EXT's HostToWebviewMessage / WebviewToHostMessage (05-contracts.yaml:715-716) as @cpg/model
// carries them (controller decision 13). Node and edge fields stay unchecked (stop-list 55).

import {
  isWorkspacePath,
  type CheckResult,
  type GraphDelta,
  type GraphPayload,
  type RenderReport,
  type VerifyCheckId,
  type WorkspacePath,
} from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { parseInspectorInput, parsePageMessage, parseWebviewMessage } from './messages';

function workspacePath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

const P: GraphPayload = { seq: 0, nodes: [{ id: 'd', type: 'DIRECTORY' }], edges: [] };
const D: GraphDelta = {
  seq: 1,
  file: workspacePath('src/h.ts'),
  revision_id: 'r1',
  producer: 'filesystem',
  addedNodes: [],
  addedEdges: [],
  removedNodeIds: [],
};
const IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];
const CHECKS: readonly CheckResult[] = IDS.map((id) => ({
  id,
  state: id === 'render-reconciliation' ? 'fail' : 'pass',
  observed: 3,
  expected: 3,
  localisedTo: [],
  asOfSeq: 0,
}));
const CHECK: CheckResult = {
  id: 'filesystem-reconciliation',
  state: 'pass',
  observed: 3,
  expected: 3,
  localisedTo: ['src'],
  detail: 'all files indexed',
  asOfSeq: 0,
};
const REPORT = { epoch: 1, seq: 0, checks: CHECKS, state: 'fail' } as const;

const graph = { type: 'graph', protocol: 1, epoch: 1, seq: 0, payload: P };
const graphDelta = { type: 'graph-delta', protocol: 1, epoch: 1, seq: 1, delta: D };
const verification = { type: 'verification', protocol: 1, epoch: 1, seq: 0, report: REPORT };
const THEME = { kind: 'dark', nodeColors: { FILE: '#123456' }, defaultNodeColor: '#abcdef' };
const theme = { type: 'theme', protocol: 1, epoch: 1, theme: THEME };

/** `base` with `key` set to `value`, or removed when `value` is undefined. */
function withField(base: object, key: string, value: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

const NOT_RECORDS: readonly unknown[] = [null, undefined, 'graph', 42, true, []];

describe('parsePageMessage (host -> page)', () => {
  it.each([
    ['graph', graph],
    ['graph-delta', graphDelta],
    ['verification', verification],
    [
      'verification with an optional detail',
      { ...verification, report: { ...REPORT, checks: [CHECK] } },
    ],
    ['a graph at epoch 0', { ...graph, epoch: 0 }],
    // Round two (review a8, a5, a6): a fresh payload's seq -1, the code tier, every state.
    ['graph of a fresh payload at seq -1', { ...graph, seq: -1, payload: { ...P, seq: -1 } }],
    ['graph-delta from the code tier', { ...graphDelta, delta: { ...D, producer: 'code' } }],
    ...(['pass', 'fail', 'stale', 'unavailable'] as const).map(
      (state) =>
        [
          `verification in state ${state}`,
          { ...verification, report: { ...REPORT, state, checks: [{ ...CHECK, state }] } },
        ] as const,
    ),
    // U3.1.1 part 3 (decision 32): a theme carries no seq.
    ...(['light', 'dark', 'high-contrast-light', 'high-contrast-dark'] as const).map(
      (kind) => [`theme of kind ${kind}`, { ...theme, theme: { ...THEME, kind } }] as const,
    ),
    ['theme with no node colours', { ...theme, theme: { ...THEME, nodeColors: {} } }],
    // The contract types a colour as a string; what can't be painted falls back (nodeTypeColor).
    ['theme whose colour is no #rrggbb', { ...theme, theme: { ...THEME, defaultNodeColor: 'x' } }],
    [
      'verification with an empty detail',
      { ...verification, report: { ...REPORT, checks: [{ ...CHECK, detail: '' }] } },
    ],
  ] as const)('accepts a well-formed %s message', (_name, message) => {
    expect(parsePageMessage(message)).toStrictEqual(message);
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ...NOT_RECORDS.map((value) => [`the non-record ${JSON.stringify(value)}`, value] as const),
    // U3.1.1 part 3 (decision 32): a theme is acted on, so a malformed one is refused.
    ['a theme at protocol 2', { ...theme, protocol: 2 }],
    ['a theme with no epoch', withField(theme, 'epoch', undefined)],
    ["a theme with epoch '1'", { ...theme, epoch: '1' }],
    ['a theme message with no theme', withField(theme, 'theme', undefined)],
    ['a theme that is a list', { ...theme, theme: [] }],
    ['a theme carrying a payload instead', { ...withField(theme, 'theme', undefined), payload: P }],
    ["a theme of kind 'sepia'", { ...theme, theme: { ...THEME, kind: 'sepia' } }],
    ['a theme with no kind', { ...theme, theme: withField(THEME, 'kind', undefined) }],
    ['a theme with no nodeColors', { ...theme, theme: withField(THEME, 'nodeColors', undefined) }],
    ['a theme with null nodeColors', { ...theme, theme: { ...THEME, nodeColors: null } }],
    [
      'a theme with a list of nodeColors',
      { ...theme, theme: { ...THEME, nodeColors: ['#000000'] } },
    ],
    ['a theme with a numeric colour', { ...theme, theme: { ...THEME, nodeColors: { FILE: 1 } } }],
    [
      'a theme with no defaultNodeColor',
      { ...theme, theme: withField(THEME, 'defaultNodeColor', undefined) },
    ],
    ['a theme with a numeric default', { ...theme, theme: { ...THEME, defaultNodeColor: 1 } }],
    ['the protocol-less archive shape', { type: 'graph', payload: P }],
    ['protocol 2', { ...graph, protocol: 2 }],
    ["protocol '1'", { ...graph, protocol: '1' }],
    ['no protocol', withField(graph, 'protocol', undefined)],
    ['no epoch', withField(graph, 'epoch', undefined)],
    ["epoch '1'", { ...graph, epoch: '1' }],
    ['no seq', withField(graph, 'seq', undefined)],
    ["seq '0'", { ...graph, seq: '0' }],
    ['a delta with no seq', withField(graphDelta, 'seq', undefined)],
    ['a verification with no seq', withField(verification, 'seq', undefined)],
    ['a graph with no payload', withField(graph, 'payload', undefined)],
    ['a graph whose payload is a string', { ...graph, payload: 'x' }],
    ['a payload with string nodes', { ...graph, payload: { ...P, nodes: 'ab' } }],
    ['a payload with no edges', { ...graph, payload: withField(P, 'edges', undefined) }],
    ['a payload with no seq', { ...graph, payload: withField(P, 'seq', undefined) }],
    ["a payload with seq '0'", { ...graph, payload: { ...P, seq: '0' } }],
    ['a graph carrying a delta', { ...withField(graph, 'payload', undefined), delta: D }],
    ['a delta carrying a payload', { ...withField(graphDelta, 'delta', undefined), payload: P }],
    ['a delta of 1', { ...graphDelta, delta: 1 }],
    ...(['addedNodes', 'addedEdges', 'removedNodeIds'] as const).flatMap((key) => [
      [`a delta with no ${key}`, { ...graphDelta, delta: withField(D, key, undefined) }] as const,
      [`a delta whose ${key} is a string`, { ...graphDelta, delta: { ...D, [key]: 'x' } }] as const,
    ]),
    ["a delta with seq '1'", { ...graphDelta, delta: { ...D, seq: '1' } }],
    ['a delta with no producer', { ...graphDelta, delta: withField(D, 'producer', undefined) }],
    ["a delta from producer 'parser'", { ...graphDelta, delta: { ...D, producer: 'parser' } }],
    ['a delta with no file', { ...graphDelta, delta: withField(D, 'file', undefined) }],
    // Round two (review a7): a file that is there but not a string.
    ['a delta with a numeric file', { ...graphDelta, delta: { ...D, file: 7 } }],
    ['a delta with a numeric revision_id', { ...graphDelta, delta: { ...D, revision_id: 7 } }],
    ['a verification with no report', withField(verification, 'report', undefined)],
    ['a report with no epoch', { ...verification, report: withField(REPORT, 'epoch', undefined) }],
    ['a report with no seq', { ...verification, report: withField(REPORT, 'seq', undefined) }],
    ["a report in state 'green'", { ...verification, report: { ...REPORT, state: 'green' } }],
    ['a report whose checks is an object', { ...verification, report: { ...REPORT, checks: {} } }],
    ['a report holding a null check', { ...verification, report: { ...REPORT, checks: [null] } }],
    // Post-implementation (sabotage #13): every check must be well-formed, not just one.
    [
      'a report with one bad check among good ones',
      { ...verification, report: { ...REPORT, checks: [...CHECKS, { ...CHECK, state: 'ok' }] } },
    ],
    [
      "a check id 'vibes'",
      { ...verification, report: { ...REPORT, checks: [{ ...CHECK, id: 'vibes' }] } },
    ],
    [
      "a check in state 'ok'",
      { ...verification, report: { ...REPORT, checks: [{ ...CHECK, state: 'ok' }] } },
    ],
    ...(['observed', 'expected', 'asOfSeq'] as const).map(
      (key) =>
        [
          `a check whose ${key} is a string`,
          { ...verification, report: { ...REPORT, checks: [{ ...CHECK, [key]: '3' }] } },
        ] as const,
    ),
    [
      'a check whose localisedTo is a string',
      { ...verification, report: { ...REPORT, checks: [{ ...CHECK, localisedTo: 'src' }] } },
    ],
    [
      'a check whose localisedTo holds a number',
      { ...verification, report: { ...REPORT, checks: [{ ...CHECK, localisedTo: [1] }] } },
    ],
    [
      'a check whose detail is a number',
      { ...verification, report: { ...REPORT, checks: [{ ...CHECK, detail: 1 }] } },
    ],
    // Round two (review a9): falsy non-strings are not "absent".
    ...([null, 0, false] as const).map(
      (detail) =>
        [
          `a check whose detail is ${String(detail)}`,
          { ...verification, report: { ...REPORT, checks: [{ ...CHECK, detail }] } },
        ] as const,
    ),
    ['a page-to-host ready', { type: 'ready', protocol: 1 }],
    ['an unknown type', { ...graph, type: 'graph-snapshot' }],
  ];
  it.each(rejected)('rejects %s', (_name, message) => {
    expect(parsePageMessage(message)).toBeUndefined();
  });
});

const RENDER: RenderReport = {
  payloadNodeCount: 3,
  renderedNodeCount: 2,
  renderedEdgeCount: 1,
  duplicateEdges: 0,
  droppedNodeIds: ['c'],
  frameMs: 1.5,
};
const renderReport = { type: 'render-report', epoch: 1, seq: 0, report: RENDER };
const RENDER_COUNTS = [
  'payloadNodeCount',
  'renderedNodeCount',
  'renderedEdgeCount',
  'duplicateEdges',
  'frameMs',
] as const;

describe('parseWebviewMessage (page -> host)', () => {
  const accepted: readonly (readonly [string, unknown])[] = [
    ['ready', { type: 'ready', protocol: 1 }],
    ['ready at another protocol (the host decides)', { type: 'ready', protocol: 2 }],
    ['reveal', { type: 'reveal', nodeId: 'd' }],
    ...(['gap', 'stale-epoch', 'render-error'] as const).map(
      (reason) => [`resync for ${reason}`, { type: 'resync', epoch: 1, seq: 0, reason }] as const,
    ),
    [
      'a resync before any graph (epoch 0, seq -1)',
      { type: 'resync', epoch: 0, seq: -1, reason: 'stale-epoch' },
    ],
    ['render-report', renderReport],
    [
      'a render-report with no dropped ids',
      { ...renderReport, report: { ...RENDER, droppedNodeIds: [] } },
    ],
  ];
  it.each(accepted)('accepts %s', (_name, message) => {
    expect(parseWebviewMessage(message)).toStrictEqual(message);
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ...NOT_RECORDS.map((value) => [`the non-record ${JSON.stringify(value)}`, value] as const),
    ['ready with no protocol (the archive shape)', { type: 'ready' }],
    ["ready at protocol '1'", { type: 'ready', protocol: '1' }],
    ['reveal with no nodeId', { type: 'reveal' }],
    ['reveal with a numeric nodeId', { type: 'reveal', nodeId: 1 }],
    ["resync for 'bored'", { type: 'resync', epoch: 1, seq: 0, reason: 'bored' }],
    ['resync with no reason', { type: 'resync', epoch: 1, seq: 0 }],
    ['the archive resync{haveSeq}', { type: 'resync', haveSeq: 0 }],
    ["resync at epoch '1'", { type: 'resync', epoch: '1', seq: 0, reason: 'gap' }],
    ['resync with no seq', { type: 'resync', epoch: 1, reason: 'gap' }],
    // Round two (review a10): present but not a number.
    ["resync at seq '0'", { type: 'resync', epoch: 1, seq: '0', reason: 'gap' }],
    ["a render-report at epoch '1'", { ...renderReport, epoch: '1' }],
    ['a render-report with no epoch', withField(renderReport, 'epoch', undefined)],
    ["a render-report at seq '0'", { ...renderReport, seq: '0' }],
    ['a render-report with no report', withField(renderReport, 'report', undefined)],
    ['a render-report whose report is null', { ...renderReport, report: null }],
    ...RENDER_COUNTS.flatMap((key) => [
      [
        `a report with no ${key}`,
        { ...renderReport, report: withField(RENDER, key, undefined) },
      ] as const,
      [
        `a report whose ${key} is a string`,
        { ...renderReport, report: { ...RENDER, [key]: '1' } },
      ] as const,
    ]),
    [
      'a report with no droppedNodeIds',
      { ...renderReport, report: withField(RENDER, 'droppedNodeIds', undefined) },
    ],
    [
      "a report whose droppedNodeIds is 'c'",
      { ...renderReport, report: { ...RENDER, droppedNodeIds: 'c' } },
    ],
    [
      'a report whose droppedNodeIds holds a number',
      { ...renderReport, report: { ...RENDER, droppedNodeIds: ['c', 3] } },
    ],
    ['a host-to-page graph', graph],
    ['an unknown type', { type: 'hello', protocol: 1 }],
  ];
  it.each(rejected)('rejects %s', (_name, message) => {
    expect(parseWebviewMessage(message)).toBeUndefined();
  });
});

describe('parseInspectorInput (stdin, decision 9a)', () => {
  const report = { seq: 0, checks: CHECKS, state: 'fail' };
  const verify = (checks: readonly unknown[]): unknown => ({
    type: 'verification',
    report: { ...report, checks },
  });
  it.each([
    ['graph', { type: 'graph', payload: P }],
    // Sprint 26 (controller decision 84): a graph says whether it starts an epoch.
    ["graph with cause 'initial'", { type: 'graph', payload: P, cause: 'initial' }],
    ["graph with cause 'catch-up'", { type: 'graph', payload: P, cause: 'catch-up' }],
    ['graph-delta', { type: 'graph-delta', delta: D }],
    [
      'verification with all six checks in enum order (C-EXT I-18)',
      { type: 'verification', report },
    ],
    ['a check with a detail', verify([{ ...CHECKS[0], detail: 'ok' }, ...CHECKS.slice(1)])],
  ])('accepts a %s line', (_name, line) => {
    expect(parseInspectorInput(line)).toStrictEqual(line);
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ...NOT_RECORDS.map((value) => [`the non-record ${JSON.stringify(value)}`, value] as const),
    ['a graph with no payload', { type: 'graph' }],
    ['a payload with string nodes', { type: 'graph', payload: { ...P, nodes: 'ab' } }],
    ['a payload with no edges', { type: 'graph', payload: withField(P, 'edges', undefined) }],
    ['a payload with no seq', { type: 'graph', payload: withField(P, 'seq', undefined) }],
    ['a delta with no seq', { type: 'graph-delta', delta: withField(D, 'seq', undefined) }],
    [
      'a delta whose removedNodeIds is a string',
      { type: 'graph-delta', delta: { ...D, removedNodeIds: 'd' } },
    ],
    [
      "a delta from producer 'parser'",
      { type: 'graph-delta', delta: { ...D, producer: 'parser' } },
    ],
    ['a graph line carrying a delta', { type: 'graph', delta: D }],
    ["a graph with cause 'live'", { type: 'graph', payload: P, cause: 'live' }],
    ['a graph with cause 1', { type: 'graph', payload: P, cause: 1 }],
    ['a verification with no report', { type: 'verification' }],
    ['a report with no seq', { type: 'verification', report: withField(report, 'seq', undefined) }],
    ["a report at seq '0' (review a10)", { type: 'verification', report: { ...report, seq: '0' } }],
    ["a report in state 'green'", { type: 'verification', report: { ...report, state: 'green' } }],
    [
      'a report with no state',
      { type: 'verification', report: withField(report, 'state', undefined) },
    ],
    [
      'a report whose checks is null',
      { type: 'verification', report: { ...report, checks: null } },
    ],
    ['no checks (I-18: all six)', verify([])],
    ['five checks', verify(CHECKS.slice(0, 5))],
    ['seven checks', verify([...CHECKS, CHECKS[0]])],
    ['six checks out of enum order', verify([CHECKS[1], CHECKS[0], ...CHECKS.slice(2)])],
    ['six checks with one twice', verify([CHECKS[0], ...CHECKS.slice(0, 5)])],
    ['a malformed check', verify([{ ...CHECKS[0], observed: '3' }, ...CHECKS.slice(1)])],
    ['an unknown type', { type: 'payload', payload: P }],
  ];
  it.each(rejected)('rejects %s', (_name, line) => {
    expect(parseInspectorInput(line)).toBeUndefined();
  });
});
