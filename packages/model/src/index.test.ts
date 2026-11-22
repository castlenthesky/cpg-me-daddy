import { describe, expect, it } from 'vitest';
import {
  applyGraphDelta,
  edgeResolution,
  nodeLocation,
  nodeResolution,
  toWorkspacePath,
  type DeltaApplyResult,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
} from './index';

const FILE_PATH = toWorkspacePath('/w', '/w/a.ts');

function payload(nodes: GraphNode[], edges: GraphEdge[] = [], seq = -1): GraphPayload {
  return { seq, nodes, edges };
}

function delta(partial: Partial<GraphDelta>): GraphDelta {
  return {
    seq: 0,
    file: FILE_PATH,
    revision_id: 'r1',
    producer: 'code',
    addedNodes: [],
    addedEdges: [],
    removedNodeIds: [],
    ...partial,
  };
}

/** Unwraps an `applied` result so a wrong outcome fails with the outcome in the message. */
function applied(result: DeltaApplyResult): GraphPayload {
  expect(result.outcome).toBe('applied');
  if (result.outcome !== 'applied') throw new Error(`expected applied, got ${result.outcome}`);
  return result.payload;
}

const empty = payload([]);

describe('applyGraphDelta', () => {
  it('adds nodes and edges, and advances seq to the delta seq', () => {
    const next = applied(
      applyGraphDelta(
        empty,
        delta({
          seq: 0,
          addedNodes: [{ id: 'a', type: 'file' }],
          addedEdges: [{ source: 'a', target: 'b', type: 'X' }],
        }),
      ),
    );
    expect(next).toEqual({
      seq: 0,
      nodes: [{ id: 'a', type: 'file' }],
      edges: [{ source: 'a', target: 'b', type: 'X' }],
    });
  });

  it('drops edges touching a removed node without the producer enumerating them', () => {
    // This is the contract that lets GraphDelta omit removedEdgeIds entirely (I-8).
    const before = payload(
      [
        { id: 'dir', type: 'file' },
        { id: 'a', type: 'file' },
        { id: 'b', type: 'file' },
      ],
      [
        { source: 'dir', target: 'a', type: 'HAS_ENTRY' },
        { source: 'dir', target: 'b', type: 'HAS_ENTRY' },
      ],
    );
    const next = applied(applyGraphDelta(before, delta({ removedNodeIds: ['a'] })));

    expect(next.nodes.map((n) => n.id)).toEqual(['dir', 'b']);
    expect(next.edges).toEqual([{ source: 'dir', target: 'b', type: 'HAS_ENTRY' }]);
  });

  it('drops an edge whose SOURCE was removed, not just its target', () => {
    const before = payload(
      [
        { id: 'a', type: 'file' },
        { id: 'b', type: 'file' },
      ],
      [{ source: 'a', target: 'b' }],
    );
    expect(applied(applyGraphDelta(before, delta({ removedNodeIds: ['a'] }))).edges).toEqual([]);
  });

  it('removing an id that does not exist is a no-op that still advances seq', () => {
    const before = payload([{ id: 'a', type: 'file' }]);
    expect(applied(applyGraphDelta(before, delta({ removedNodeIds: ['zzz'] })))).toEqual({
      seq: 0,
      nodes: [{ id: 'a', type: 'file' }],
      edges: [],
    });
  });

  it('does not mutate its arguments', () => {
    const before = payload([{ id: 'a', type: 'file' }]);
    const d = delta({ addedNodes: [{ id: 'b', type: 'file' }], removedNodeIds: ['a'] });
    const snapshot = JSON.stringify([before, d]);
    applyGraphDelta(before, d);
    expect(JSON.stringify([before, d])).toEqual(snapshot);
  });

  // INVERTED CHARACTERIZATION TEST. It replaces `DUPLICATES a re-added node id when the producer
  // omits the removal`, which pinned the L-01 hazard (concat merge). Spec (U1.2.1, DQ-01c): a
  // re-added id merges by per-property owner and never duplicates.
  it('[D2] a re-added id MERGES in place — it does not duplicate', () => {
    const before = payload([
      { id: 'x', type: 'DIRECTORY' },
      {
        id: 'f',
        type: 'FILE',
        name: 'a.ts',
        data: { path: 'a.ts', content_hash: 'h1', revision_id: 'r1' },
      },
      { id: 'y', type: 'DIRECTORY' },
    ]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'code',
          addedNodes: [{ id: 'f', type: 'FILE', data: { interface_hash: 'i1', loc: 12 } }],
        }),
      ),
    );

    expect(next.nodes.map((n) => n.id)).toEqual(['x', 'f', 'y']);
    expect(next.nodes[1]?.data).toEqual({
      path: 'a.ts',
      content_hash: 'h1',
      revision_id: 'r1',
      interface_hash: 'i1',
      loc: 12,
    });
  });

  it('an update expressed as remove-then-add yields exactly one node (a whole replace)', () => {
    const before = payload([{ id: 'a', type: 'METHOD', name: 'old', data: { signature: 's' } }]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          removedNodeIds: ['a'],
          addedNodes: [{ id: 'a', type: 'METHOD', name: 'updated' }],
        }),
      ),
    );
    // Fresh node: the old `signature` is gone (D11).
    expect(next.nodes).toEqual([{ id: 'a', type: 'METHOD', name: 'updated' }]);
  });

  it('a removed-then-re-added id is appended at the end, not kept at its old index (D11)', () => {
    const before = payload([
      { id: 'a', type: 'METHOD' },
      { id: 'b', type: 'METHOD' },
    ]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({ removedNodeIds: ['a'], addedNodes: [{ id: 'a', type: 'METHOD' }] }),
      ),
    );
    expect(next.nodes.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('new ids append after survivors in delta order (I-7)', () => {
    const before = payload([{ id: 'a', type: 'METHOD' }]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          addedNodes: [
            { id: 'z', type: 'METHOD' },
            { id: 'm', type: 'METHOD' },
          ],
        }),
      ),
    );
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'z', 'm']);
  });
});

describe('applyGraphDelta owner merge (DQ-01c, D4, D6)', () => {
  const fileBoth: GraphNode = {
    id: 'f',
    type: 'FILE',
    name: 'a.ts',
    data: { path: 'a.ts', content_hash: 'h1', revision_id: 'r1', interface_hash: 'i1', loc: 10 },
  };

  it('a code re-add replaces the code slice, DROPS an omitted code field, keeps the filesystem slice', () => {
    const next = applied(
      applyGraphDelta(
        payload([fileBoth]),
        delta({
          producer: 'code',
          addedNodes: [{ id: 'f', type: 'FILE', data: { loc: 99, version: 2 } }],
        }),
      ),
    );
    expect(next.nodes[0]).toEqual({
      id: 'f',
      type: 'FILE',
      name: 'a.ts', // FILE.name is filesystem-owned; the code re-add carried no say over it
      data: { path: 'a.ts', content_hash: 'h1', revision_id: 'r1', loc: 99, version: 2 },
    });
  });

  it('a code re-add of FILE ignores a name it carries (FILE.name is filesystem-owned, D1)', () => {
    const next = applied(
      applyGraphDelta(
        payload([fileBoth]),
        delta({
          producer: 'code',
          addedNodes: [{ id: 'f', type: 'FILE', name: 'ignored.ts', data: { loc: 1 } }],
        }),
      ),
    );
    expect(next.nodes[0]?.name).toBe('a.ts');
  });

  it('a filesystem re-add of FILE that omits name drops it (D6: a tier retracts its own key)', () => {
    const next = applied(
      applyGraphDelta(
        payload([fileBoth]),
        delta({
          producer: 'filesystem',
          addedNodes: [{ id: 'f', type: 'FILE', data: { path: 'a.ts' } }],
        }),
      ),
    );
    expect(next.nodes[0]).not.toHaveProperty('name');
  });

  it('a filesystem re-add (a save) keeps every code field and ignores a code field it carries', () => {
    const next = applied(
      applyGraphDelta(
        payload([fileBoth]),
        delta({
          producer: 'filesystem',
          addedNodes: [
            {
              id: 'f',
              type: 'FILE',
              name: 'renamed.ts',
              data: { path: 'a.ts', content_hash: 'h2', revision_id: 'r2', loc: 777 },
            },
          ],
        }),
      ),
    );
    expect(next.nodes[0]).toEqual({
      id: 'f',
      type: 'FILE',
      name: 'renamed.ts', // FILE.name follows its owner (filesystem)
      data: {
        path: 'a.ts',
        content_hash: 'h2',
        revision_id: 'r2',
        interface_hash: 'i1',
        loc: 10, // incoming loc ignored: the filesystem tier does not own it
      },
    });
  });

  it('a filesystem re-add can retract its own optional field (language)', () => {
    const before = payload([
      { id: 'f', type: 'FILE', data: { path: 'a.ts', language: 'typescript', loc: 3 } },
    ]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'filesystem',
          addedNodes: [{ id: 'f', type: 'FILE', data: { path: 'a.ts' } }],
        }),
      ),
    );
    expect(next.nodes[0]?.data).toEqual({ path: 'a.ts', loc: 3 });
  });

  it('undeclared keys on a known label belong to the label home tier (D2): filesystem cannot clobber FILE.location', () => {
    const before = payload([{ id: 'f', type: 'FILE', data: { location: 'kept', path: 'a.ts' } }]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'filesystem',
          addedNodes: [{ id: 'f', type: 'FILE', data: { location: 'x', path: 'a.ts' } }],
        }),
      ),
    );
    // FILE's home tier is filesystem, so an undeclared key is filesystem-owned and the incoming wins.
    expect(next.nodes[0]?.data).toEqual({ location: 'x', path: 'a.ts' });

    const code = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'code',
          addedNodes: [{ id: 'f', type: 'FILE', data: { location: 'x' } }],
        }),
      ),
    );
    expect(code.nodes[0]?.data).toEqual({ location: 'kept', path: 'a.ts' });
  });

  // Key order is a stated determinism decision (I-7/D15), not an accident: this test couples to it on purpose.
  it('preserved keys come first in the existing order, then the producer keys in incoming order (D15)', () => {
    const before = payload([
      { id: 'f', type: 'FILE', data: { path: 'a.ts', content_hash: 'h1', loc: 1 } },
    ]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'code',
          addedNodes: [{ id: 'f', type: 'FILE', data: { version: 3, loc: 2 } }],
        }),
      ),
    );
    expect(Object.keys(next.nodes[0]?.data ?? {})).toEqual([
      'path',
      'content_hash',
      'version',
      'loc',
    ]);
  });

  it('a merge-on-key DIRECTORY re-added by its own tier is an upsert, not malformed', () => {
    const before = payload([
      { id: 'd', type: 'DIRECTORY', name: 'src', data: { path: 'src', status: 'active' } },
    ]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'filesystem',
          addedNodes: [
            { id: 'd', type: 'DIRECTORY', name: 'src', data: { path: 'src', status: 'deleted' } },
          ],
        }),
      ),
    );
    expect(next.nodes).toEqual([
      { id: 'd', type: 'DIRECTORY', name: 'src', data: { path: 'src', status: 'deleted' } },
    ]);
  });

  it('a merge-on-key SYMBOL re-added by the code tier is an upsert, not malformed', () => {
    const before = payload([{ id: 's', type: 'SYMBOL', data: { fqn: 'a.b', kind: 'old' } }]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'code',
          addedNodes: [{ id: 's', type: 'SYMBOL', data: { fqn: 'a.b', kind: 'new' } }],
        }),
      ),
    );
    expect(next.nodes).toEqual([{ id: 's', type: 'SYMBOL', data: { fqn: 'a.b', kind: 'new' } }]);
  });

  it('a cross-tier re-add of a label the producer owns nothing on leaves the node unchanged (D8)', () => {
    const m: GraphNode = { id: 'm', type: 'METHOD', name: 'foo', data: { signature: 's' } };
    const next = applied(
      applyGraphDelta(
        payload([m]),
        delta({
          producer: 'filesystem',
          addedNodes: [{ id: 'm', type: 'METHOD', name: 'hijack', data: { signature: 'evil' } }],
        }),
      ),
    );
    expect(next.nodes).toEqual([m]);
  });

  it('a re-add where neither node has data yields no data key', () => {
    const next = applied(
      applyGraphDelta(
        payload([{ id: 'f', type: 'FILE' }]),
        delta({ addedNodes: [{ id: 'f', type: 'FILE' }] }),
      ),
    );
    expect(next.nodes[0]).toEqual({ id: 'f', type: 'FILE' });
    expect('data' in (next.nodes[0] ?? {})).toBe(false);
  });

  it('a re-add where only the incoming node has data yields that data', () => {
    const next = applied(
      applyGraphDelta(
        payload([{ id: 'f', type: 'FILE' }]),
        delta({ addedNodes: [{ id: 'f', type: 'FILE', data: { loc: 4 } }] }),
      ),
    );
    expect(next.nodes[0]?.data).toEqual({ loc: 4 });
  });

  it('a code re-add that carries no data keeps the existing filesystem slice only on a FILE with data (D15)', () => {
    const next = applied(
      applyGraphDelta(
        payload([fileBoth]),
        delta({ producer: 'code', addedNodes: [{ id: 'f', type: 'FILE' }] }),
      ),
    );
    // Only the existing node has data: the result has data, holding just the filesystem-owned keys.
    expect(next.nodes[0]?.data).toEqual({ path: 'a.ts', content_hash: 'h1', revision_id: 'r1' });
  });

  it('an unknown label shallow-merges and never destroys the other producer fields (D9)', () => {
    const before = payload([{ id: 'u', type: 'file', name: 'old', data: { a: 1, b: 2 } }]);
    const next = applied(
      applyGraphDelta(
        before,
        delta({
          producer: 'code',
          addedNodes: [{ id: 'u', type: 'file', data: { b: 3, c: 4 } }],
        }),
      ),
    );
    expect(next.nodes).toEqual([
      { id: 'u', type: 'file', name: 'old', data: { a: 1, b: 3, c: 4 } },
    ]);
  });

  it('an unknown label re-add takes the incoming name when it has one (D9)', () => {
    const next = applied(
      applyGraphDelta(
        payload([{ id: 'u', type: 'file', name: 'old' }]),
        delta({ addedNodes: [{ id: 'u', type: 'file', name: 'new' }] }),
      ),
    );
    expect(next.nodes[0]?.name).toBe('new');
  });
});

describe('applyGraphDelta malformed (D7)', () => {
  const method: GraphNode = { id: 'm', type: 'METHOD', name: 'foo' };

  it('a same-producer re-add of a delete-create label without removal is malformed', () => {
    const result = applyGraphDelta(
      payload([method]),
      delta({ producer: 'code', addedNodes: [{ id: 'm', type: 'METHOD', name: 'bar' }] }),
    );
    expect(result).toEqual({
      outcome: 'malformed',
      defects: [{ code: 'readd-without-removal', nodeId: 'm' }],
    });
  });

  it('the same delete-create id twice in one delta is malformed (the second re-adds the first)', () => {
    const result = applyGraphDelta(
      empty,
      delta({
        addedNodes: [
          { id: 'm', type: 'METHOD' },
          { id: 'm', type: 'METHOD' },
        ],
      }),
    );
    expect(result).toEqual({
      outcome: 'malformed',
      defects: [{ code: 'readd-without-removal', nodeId: 'm' }],
    });
  });

  it('the same merge-on-key id twice in one delta is two sequential upserts', () => {
    const next = applied(
      applyGraphDelta(
        empty,
        delta({
          addedNodes: [
            { id: 's', type: 'SYMBOL', data: { fqn: 'a', kind: 'one' } },
            { id: 's', type: 'SYMBOL', data: { fqn: 'a', kind: 'two' } },
          ],
        }),
      ),
    );
    expect(next.nodes).toEqual([{ id: 's', type: 'SYMBOL', data: { fqn: 'a', kind: 'two' } }]);
  });

  it('a type conflict on one id is malformed', () => {
    const result = applyGraphDelta(
      payload([{ id: 'x', type: 'FILE' }]),
      delta({ addedNodes: [{ id: 'x', type: 'DIRECTORY' }] }),
    );
    expect(result).toEqual({
      outcome: 'malformed',
      defects: [{ code: 'type-conflict', nodeId: 'x' }],
    });
  });

  it('a type conflict on an unknown label is also malformed (D9: the only defect it can have)', () => {
    const result = applyGraphDelta(
      payload([{ id: 'x', type: 'file' }]),
      delta({ addedNodes: [{ id: 'x', type: 'directory' }] }),
    );
    expect(result).toEqual({
      outcome: 'malformed',
      defects: [{ code: 'type-conflict', nodeId: 'x' }],
    });
  });

  it('removing an id and re-adding it with a different type is a fresh node, not a conflict', () => {
    const next = applied(
      applyGraphDelta(
        payload([{ id: 'x', type: 'FILE' }]),
        delta({ removedNodeIds: ['x'], addedNodes: [{ id: 'x', type: 'DIRECTORY' }] }),
      ),
    );
    expect(next.nodes).toEqual([{ id: 'x', type: 'DIRECTORY' }]);
  });

  it('lists one defect per offending node, in addedNodes order', () => {
    const result = applyGraphDelta(
      payload([
        { id: 'm1', type: 'METHOD' },
        { id: 'm2', type: 'METHOD' },
        { id: 'ok', type: 'FILE' },
      ]),
      delta({
        addedNodes: [
          { id: 'm2', type: 'METHOD' },
          { id: 'ok', type: 'FILE' },
          { id: 'm1', type: 'METHOD' },
        ],
      }),
    );
    expect(result).toEqual({
      outcome: 'malformed',
      defects: [
        { code: 'readd-without-removal', nodeId: 'm2' },
        { code: 'readd-without-removal', nodeId: 'm1' },
      ],
    });
  });

  it('malformed is all-or-nothing: no payload is returned and neither input changes', () => {
    const before = payload([method]);
    const d = delta({
      addedNodes: [
        { id: 'fresh', type: 'METHOD' },
        { id: 'm', type: 'METHOD' },
      ],
      removedNodeIds: [],
    });
    const snapshot = JSON.stringify([before, d]);
    const result = applyGraphDelta(before, d);
    expect(result.outcome).toBe('malformed');
    expect('payload' in result).toBe(false);
    expect(JSON.stringify([before, d])).toBe(snapshot);
  });
});

describe('applyGraphDelta seq gate (I-10, D10)', () => {
  const before = payload([{ id: 'a', type: 'METHOD' }], [], 5);

  it('delta.seq === payload.seq + 1 applies and the result carries delta.seq', () => {
    expect(applied(applyGraphDelta(before, delta({ seq: 6 }))).seq).toBe(6);
  });

  it('the first delta (seq 0) applies to a fresh payload (seq -1)', () => {
    expect(applied(applyGraphDelta(empty, delta({ seq: 0 }))).seq).toBe(0);
  });

  it('a delta at or below payload.seq is already-applied and returns the SAME payload object', () => {
    for (const seq of [5, 0, -3]) {
      const result = applyGraphDelta(
        before,
        delta({ seq, addedNodes: [{ id: 'zz', type: 'METHOD' }] }),
      );
      expect(result.outcome).toBe('already-applied');
      expect('payload' in result && result.payload === before).toBe(true);
    }
  });

  it.each([
    ['one ahead of expected', 7, 6],
    ['far ahead', 100, 6],
    ['NaN', Number.NaN, 6],
    ['non-integer above', 6.5, 6],
    ['Infinity', Number.POSITIVE_INFINITY, 6],
  ])('%s is a gap reporting expected and got', (_name, got, expected) => {
    const result = applyGraphDelta(before, delta({ seq: got }));
    expect(result.outcome).toBe('gap');
    expect('expected' in result ? result.expected : undefined).toBe(expected);
    expect('got' in result && Object.is(result.got, got)).toBe(true);
    expect('payload' in result).toBe(false);
  });

  it('a replay of a delta that would now be malformed is already-applied, not malformed', () => {
    const state = payload([{ id: 'm', type: 'METHOD' }], [], 3);
    const replay = delta({ seq: 3, addedNodes: [{ id: 'm', type: 'METHOD' }] });
    expect(applyGraphDelta(state, replay).outcome).toBe('already-applied');
  });

  it('the seq gate runs before the defect check: a gap with a malformed body is a gap', () => {
    const state = payload([{ id: 'm', type: 'METHOD' }], [], 3);
    const result = applyGraphDelta(
      state,
      delta({ seq: 9, addedNodes: [{ id: 'm', type: 'METHOD' }] }),
    );
    expect(result).toEqual({ outcome: 'gap', expected: 4, got: 9 });
  });
});

describe('applyGraphDelta edges', () => {
  it('an edge-only delta applies and advances seq (INV-4)', () => {
    const before = payload(
      [
        { id: 'a', type: 'METHOD' },
        { id: 'b', type: 'METHOD' },
      ],
      [],
      2,
    );
    const next = applied(
      applyGraphDelta(
        before,
        delta({ seq: 3, addedEdges: [{ source: 'a', target: 'b', type: 'CALLS' }] }),
      ),
    );
    expect(next.seq).toBe(3);
    expect(next.nodes).toEqual(before.nodes);
    expect(next.edges).toEqual([{ source: 'a', target: 'b', type: 'CALLS' }]);
  });

  it('an empty delta applies and advances seq with nodes and edges unchanged', () => {
    const before = payload([{ id: 'a', type: 'METHOD' }], [{ source: 'a', target: 'a' }], 0);
    const next = applied(applyGraphDelta(before, delta({ seq: 1 })));
    expect(next).toEqual({ ...before, seq: 1 });
  });

  it('an added edge whose endpoint is absent is retained (I-9)', () => {
    const next = applied(
      applyGraphDelta(empty, delta({ addedEdges: [{ source: 'ghost', target: 'nowhere' }] })),
    );
    expect(next.edges).toEqual([{ source: 'ghost', target: 'nowhere' }]);
  });

  it('an added edge touching an id removed in the same delta is kept (removal applies to pre-existing edges only)', () => {
    const next = applied(
      applyGraphDelta(
        payload([{ id: 'a', type: 'METHOD' }]),
        delta({
          removedNodeIds: ['a'],
          addedNodes: [{ id: 'a', type: 'METHOD' }],
          addedEdges: [{ source: 'a', target: 'a', type: 'CALLS' }],
        }),
      ),
    );
    expect(next.edges).toEqual([{ source: 'a', target: 'a', type: 'CALLS' }]);
  });

  it('edges are append-only: survivors in order, then added edges in order, no dedupe (D12)', () => {
    const e1 = { source: 'a', target: 'b', type: 'T' };
    const e2 = { source: 'b', target: 'a', type: 'T' };
    const next = applied(
      applyGraphDelta(
        payload(
          [
            { id: 'a', type: 'METHOD' },
            { id: 'b', type: 'METHOD' },
          ],
          [e1],
        ),
        delta({ addedEdges: [e2, e1] }),
      ),
    );
    expect(next.edges).toEqual([e1, e2, e1]);
  });
});

describe('nodeLocation', () => {
  const range = { startRow: 1, startColumn: 0, endRow: 3, endColumn: 1 };

  it('reads a well-formed location', () => {
    const got = nodeLocation({
      id: 'a',
      type: 'METHOD',
      data: { location: { filePath: '/x.ts', range } },
    });
    expect(got).toEqual({ filePath: '/x.ts', range });
  });

  it('carries nameRange when present, since range alone lands the caret one token short', () => {
    const nameRange = { startRow: 1, startColumn: 9, endRow: 1, endColumn: 12 };
    const got = nodeLocation({
      id: 'a',
      type: 'METHOD',
      data: { location: { filePath: '/x.ts', range, nameRange } },
    });
    expect(got?.nameRange).toEqual(nameRange);
  });

  it.each([
    ['no data at all', { id: 'a', type: 'directory' }],
    ['no location key', { id: 'a', type: 'file', data: {} }],
    ['location is null', { id: 'a', type: 'file', data: { location: null } }],
    [
      'filePath is not a string',
      { id: 'a', type: 'file', data: { location: { filePath: 7, range } } },
    ],
    [
      'range is malformed',
      { id: 'a', type: 'file', data: { location: { filePath: '/x.ts', range: { startRow: 1 } } } },
    ],
  ])('returns undefined rather than throwing: %s', (_label, node) => {
    expect(nodeLocation(node)).toBeUndefined();
  });
});

describe('resolution accessors', () => {
  it('reads resolution off a node, which is how an ABSENT edge explains itself', () => {
    // The interesting cases have no edge at all — a builtin, or a reference
    // nothing could resolve. Edge-only provenance cannot describe those.
    const got = nodeResolution({
      id: 'call:1',
      type: 'CALL',
      data: { resolution: { status: 'external', resolvedBy: 'python-path', reason: 'stdlib' } },
    });
    expect(got).toEqual({ status: 'external', resolvedBy: 'python-path', reason: 'stdlib' });
  });

  it('reads resolution off an edge', () => {
    const got = edgeResolution({
      source: 'a',
      target: 'b',
      data: { resolution: { status: 'resolved', resolvedBy: 'lsp', confidence: 0.9 } },
    });
    expect(got).toEqual({ status: 'resolved', resolvedBy: 'lsp', confidence: 0.9 });
  });

  it('requires both status and resolvedBy, so provenance is never half-recorded', () => {
    expect(
      edgeResolution({ source: 'a', target: 'b', data: { resolution: { status: 'resolved' } } }),
    ).toBeUndefined();
    expect(
      edgeResolution({ source: 'a', target: 'b', data: { resolution: { resolvedBy: 'lsp' } } }),
    ).toBeUndefined();
  });

  it('accepts a status string this package has never heard of', () => {
    // Deliberate: a producer emitting a new status must degrade to "unknown
    // status", not fail to typecheck across a package boundary.
    expect(
      edgeResolution({
        source: 'a',
        target: 'b',
        data: { resolution: { status: 'speculative', resolvedBy: 'x' } },
      }),
    ).toEqual({ status: 'speculative', resolvedBy: 'x' });
  });
});
