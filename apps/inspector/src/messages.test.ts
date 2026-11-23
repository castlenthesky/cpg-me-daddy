// The page's typed boundary (C-EXT may_not "type the webview boundary loosely"): parsePageMessage
// returns a host message when every field the page reads has its contract type, and undefined
// otherwise; it never throws. Shapes are C-EXT's HostToWebviewMessage (05-contracts.yaml:715) as
// @cpg/model carries them (controller decision 13). Node and edge fields stay unchecked (stop-list 55).

import {
  isWorkspacePath,
  type CheckResult,
  type GraphDelta,
  type GraphPayload,
  type VerifyCheckId,
  type WorkspacePath,
} from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { parsePageMessage } from './messages';

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
  ])('accepts a well-formed %s message', (_name, message) => {
    expect(parsePageMessage(message)).toStrictEqual(message);
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ...NOT_RECORDS.map((value) => [`the non-record ${JSON.stringify(value)}`, value] as const),
    [
      'a theme message (not acted on yet, decision 14)',
      {
        type: 'theme',
        protocol: 1,
        epoch: 1,
        theme: { kind: 'dark', nodeColors: {}, defaultNodeColor: 'x' },
      },
    ],
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
    ['a delta with a numeric revision_id', { ...graphDelta, delta: { ...D, revision_id: 7 } }],
    ['a verification with no report', withField(verification, 'report', undefined)],
    ['a report with no epoch', { ...verification, report: withField(REPORT, 'epoch', undefined) }],
    ['a report with no seq', { ...verification, report: withField(REPORT, 'seq', undefined) }],
    ["a report in state 'green'", { ...verification, report: { ...REPORT, state: 'green' } }],
    ['a report whose checks is an object', { ...verification, report: { ...REPORT, checks: {} } }],
    ['a report holding a null check', { ...verification, report: { ...REPORT, checks: [null] } }],
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
    ['a page-to-host ready', { type: 'ready', protocol: 1 }],
    ['an unknown type', { ...graph, type: 'graph-snapshot' }],
  ];
  it.each(rejected)('rejects %s', (_name, message) => {
    expect(parsePageMessage(message)).toBeUndefined();
  });
});
