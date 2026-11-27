import { describe, expect, it } from 'vitest';
import {
  applyGraphDelta,
  readEdgeResolution,
  readNodeLocation,
  readNodeResolution,
  toWorkspacePath,
  validatePayload,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type Read,
  type EdgeResolution,
} from './index';

/** The C-MODEL conformance suite (05-contracts.yaml), one block per invariant id, run against an implementation. */
interface ModelImpl {
  applyGraphDelta: typeof applyGraphDelta;
  validatePayload: typeof validatePayload;
  readNodeLocation: typeof readNodeLocation;
  readNodeResolution: typeof readNodeResolution;
  readEdgeResolution: typeof readEdgeResolution;
}

const NUL = '\u0000';
const range = { startRow: 1, startColumn: 0, endRow: 3, endColumn: 1 };
const node = (id: string, data?: Record<string, unknown>): GraphNode => ({
  id,
  type: 'METHOD',
  ...(data === undefined ? {} : { data }),
});
const edge = (source: unknown, target: unknown, data?: Record<string, unknown>): GraphEdge =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately loose: JSON from outside is not type-checked.
  ({ source, target, ...(data === undefined ? {} : { data }) }) as GraphEdge;
// Decision 108's helpers: a 0-based range, a code-tier node, and the defect a bad key gives.
const at = (startRow: number, startColumn: number, endRow: number, endColumn: number) => ({
  startRow,
  startColumn,
  endRow,
  endColumn,
});
const MAX = Number.MAX_SAFE_INTEGER;
const code = (data: Record<string, unknown>) => node('n', { file: 'pkg/m.py', ...data });
const badKey = (key: string) => ({
  state: 'malformed',
  defect: { code: 'malformed-location', detail: `node "n" data.${key} is malformed`, nodeId: 'n' },
});
const payload = (nodes: GraphNode[], edges: GraphEdge[] = [], seq = -1): GraphPayload => ({
  seq,
  nodes,
  edges,
});
const delta = (partial: Partial<GraphDelta>): GraphDelta => ({
  seq: 0,
  file: toWorkspacePath('/w', '/w/a.ts'),
  revision_id: 'r1',
  producer: 'code',
  addedNodes: [],
  addedEdges: [],
  removedNodeIds: [],
  ...partial,
});
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function verifyModelContract(name: string, impl: ModelImpl): void {
  const codes = (p: GraphPayload, previousSeq?: number) =>
    impl
      .validatePayload(p, previousSeq === undefined ? undefined : { previousSeq })
      .map((d) => d.code);

  describe(`${name} C-MODEL I-3 no id contains U+0000`, () => {
    it('reports a NUL in a node id with its index and id', () => {
      const id = `a${NUL}b`;
      expect(impl.validatePayload(payload([node('ok'), node(id)]))).toMatchObject([
        { code: 'id-contains-separator', nodeIndex: 1, nodeId: id },
      ]);
    });
    it('reports a NUL in an edge target once, as an id defect and not also dangling', () => {
      const id = `t${NUL}`;
      expect(impl.validatePayload(payload([node('a')], [edge('a', id)]))).toMatchObject([
        { code: 'id-contains-separator', edgeIndex: 0, endpoint: 'target', nodeId: id },
      ]);
    });
    it('reports a NUL in an edge source once, as an id defect and not also dangling', () => {
      const id = `s${NUL}`;
      expect(impl.validatePayload(payload([node('a')], [edge(id, 'a')]))).toMatchObject([
        { code: 'id-contains-separator', edgeIndex: 0, endpoint: 'source', nodeId: id },
      ]);
    });
    it('allows ":" and "%" in ids (rule-addressed ids are legal)', () => {
      expect(codes(payload([node('file:a%3Ab.ts')]))).toEqual([]);
    });
  });

  describe(`${name} C-MODEL I-4 node ids are unique`, () => {
    it('reports every occurrence after the first', () => {
      const defects = impl.validatePayload(payload([node('a'), node('b'), node('a'), node('a')]));
      expect(defects).toMatchObject([
        { code: 'duplicate-node-id', nodeId: 'a', nodeIndex: 2 },
        { code: 'duplicate-node-id', nodeId: 'a', nodeIndex: 3 },
      ]);
    });
    it('reports a duplicate even when the types differ', () => {
      const p = payload([node('a'), { id: 'a', type: 'OTHER' }]);
      expect(codes(p)).toEqual(['duplicate-node-id']);
    });
    it('reports nothing for unique ids', () => {
      expect(codes(payload([node('a'), node('b')]))).toEqual([]);
    });
  });

  describe(`${name} C-MODEL I-5 / I-8 / I-10 envelope cross-checks`, () => {
    it('I-5 applies removals before additions, so remove-then-add the same id leaves the new node', () => {
      const re: GraphNode = { id: 'a', type: 'METHOD', name: 'new' };
      const r = impl.applyGraphDelta(
        payload([node('a')], [], -1),
        delta({ removedNodeIds: ['a'], addedNodes: [re] }),
      );
      expect(r).toMatchObject({ outcome: 'applied', payload: { seq: 0, nodes: [re] } });
    });
    it('I-8 removing a node drops its incident edges and keeps the others', () => {
      const keep = edge('b', 'c');
      const r = impl.applyGraphDelta(
        payload([node('a'), node('b'), node('c')], [edge('a', 'b'), keep, edge('c', 'a')]),
        delta({ removedNodeIds: ['a'] }),
      );
      expect(r).toMatchObject({ outcome: 'applied', payload: { edges: [keep] } });
    });
    it.each([
      { seq: 0, want: { outcome: 'applied' } },
      { seq: -1, want: { outcome: 'already-applied' } },
      { seq: 1, want: { outcome: 'gap', expected: 0, got: 1 } },
    ])('I-10 delta seq $seq against payload seq -1 is $want.outcome', ({ seq, want }) => {
      expect(impl.applyGraphDelta(payload([]), delta({ seq }))).toMatchObject(want);
    });
  });

  describe(`${name} C-MODEL I-9 a dangling edge is retained`, () => {
    it('reports a missing target with edgeIndex, endpoint and the missing id', () => {
      const p = payload([node('a')], [edge('a', 'a'), edge('a', 'gone')]);
      expect(impl.validatePayload(p)).toMatchObject([
        { code: 'dangling-edge', edgeIndex: 1, endpoint: 'target', nodeId: 'gone' },
      ]);
      expect(p.edges).toHaveLength(2);
    });
    it('reports one defect per missing endpoint, source before target', () => {
      expect(impl.validatePayload(payload([], [edge('x', 'y')]))).toMatchObject([
        { code: 'dangling-edge', edgeIndex: 0, endpoint: 'source', nodeId: 'x' },
        { code: 'dangling-edge', edgeIndex: 0, endpoint: 'target', nodeId: 'y' },
      ]);
    });
    it('keeps the edge through an unrelated delta and is clean once its node arrives', () => {
      const p = payload([node('a'), node('b')], [edge('a', 'm')], 0);
      const mid = impl.applyGraphDelta(p, delta({ seq: 1, removedNodeIds: ['b'] }));
      if (mid.outcome !== 'applied') throw new Error('expected applied');
      expect(mid.payload.edges).toEqual([edge('a', 'm')]);
      expect(codes(mid.payload)).toEqual(['dangling-edge']);
      const end = impl.applyGraphDelta(
        mid.payload,
        delta({ seq: 2, addedNodes: [{ id: 'm', type: 'METHOD' }] }),
      );
      if (end.outcome !== 'applied') throw new Error('expected applied');
      expect(codes(end.payload)).toEqual([]);
    });
  });

  describe(`${name} C-MODEL I-11 purity`, () => {
    const full = payload(
      [
        node('a', {
          location: { filePath: 'a.ts', range },
          resolution: { status: 's', resolvedBy: 'r' },
        }),
        node('a'),
      ],
      [edge('a', 'zz', { resolution: 7 })],
      3,
    );
    it('does not throw on a deeply frozen input and gives deep-equal output twice', () => {
      const frozen = deepFreeze(structuredClone(full));
      const first = impl.validatePayload(frozen, { previousSeq: 9 });
      expect(impl.validatePayload(frozen, { previousSeq: 9 })).toEqual(first);
      expect(first.length).toBeGreaterThan(0);
      expect(() => {
        impl.readNodeLocation(frozen.nodes.at(0) ?? node('x'));
        impl.readNodeResolution(frozen.nodes.at(0) ?? node('x'));
        impl.readEdgeResolution(frozen.edges.at(0) ?? edge('a', 'b'));
      }).not.toThrow();
    });
    it('does not mutate its input', () => {
      const copy = structuredClone(full);
      impl.validatePayload(full);
      expect(full).toEqual(copy);
    });
  });

  describe(`${name} C-MODEL I-13 unknown types are legal`, () => {
    it('an unknown node type and edge type with no location or resolution yield no defects', () => {
      const p = payload(
        [{ id: 'x', type: 'X-FUTURE' }, node('y')],
        [{ source: 'x', target: 'y', type: 'NEW_EDGE' }],
      );
      expect(impl.validatePayload(p)).toEqual([]);
    });
  });

  describe(`${name} C-MODEL I-14 absent is not malformed`, () => {
    const loc = (filePath: unknown, r: unknown = range, extra: object = {}) => ({
      filePath,
      range: r,
      ...extra,
    });
    const locNode = (location: unknown) => node('n', { location });
    const nameRange = { startRow: 1, startColumn: 9, endRow: 1, endColumn: 12 };

    it.each([
      ['no data', node('n')],
      ['data without the key', node('n', {})],
      ['undefined', locNode(undefined)],
      ['null', locNode(null)],
    ])('readNodeLocation: %s is absent', (_n, n) => {
      expect(impl.readNodeLocation(n)).toEqual({ state: 'absent' });
    });

    it.each([
      ['range only', loc('src/x.ts'), { filePath: 'src/x.ts', range }],
      [
        'with nameRange',
        loc('src/x.ts', range, { nameRange }),
        { filePath: 'src/x.ts', range, nameRange },
      ],
      [
        'nameRange null counts as absent',
        loc('src/x.ts', range, { nameRange: null }),
        { filePath: 'src/x.ts', range },
      ],
      [
        'zero-width range',
        loc('x.ts', { startRow: 2, startColumn: 4, endRow: 2, endColumn: 4 }),
        { filePath: 'x.ts', range: { startRow: 2, startColumn: 4, endRow: 2, endColumn: 4 } },
      ],
      [
        'extra keys are stripped',
        loc('src/x.ts', range, { junk: 1 }),
        { filePath: 'src/x.ts', range },
      ],
    ])('readNodeLocation: %s is present', (_n, stored, want) => {
      const got = impl.readNodeLocation(locNode(stored));
      expect(got).toEqual({ state: 'present', value: want });
      // Fresh object, never the stored reference.
      expect('value' in got && Object.is(got.value, stored)).toBe(false);
    });

    it.each([
      ['absolute path', loc('/abs/x.ts')],
      ['./ path', loc('./x.ts')],
      ['empty segment', loc('a//b.ts')],
      ['root "."', loc('.')],
      ['empty path', loc('')],
      ['non-string path', loc(5)],
      ['missing range', { filePath: 'x.ts' }],
      ['range rows reversed', loc('x.ts', { ...range, startRow: 4 })],
      [
        'range columns reversed on one row',
        loc('x.ts', { startRow: 1, startColumn: 5, endRow: 1, endColumn: 4 }),
      ],
      ['negative field', loc('x.ts', { ...range, startColumn: -1 })],
      ['fractional field', loc('x.ts', { ...range, endRow: 1.5 })],
      ['NaN field', loc('x.ts', { ...range, endColumn: Number.NaN })],
      ['string field', loc('x.ts', { ...range, endColumn: '1' })],
      ['nameRange {}', loc('x.ts', range, { nameRange: {} })],
      [
        'nameRange reversed',
        loc('x.ts', range, { nameRange: { startRow: 2, startColumn: 0, endRow: 1, endColumn: 0 } }),
      ],
      ['a string', 'src/x.ts'],
      ['an array', []],
      ['a number', 7],
      ['zero', 0],
      ['false', false],
      ['empty string', ''],
    ])('readNodeLocation: %s is malformed-location naming the node', (_n, stored) => {
      expect(impl.readNodeLocation(locNode(stored))).toMatchObject({
        state: 'malformed',
        defect: { code: 'malformed-location', nodeId: 'n' },
      });
    });

    const ok = { status: 'resolved', resolvedBy: 'lsp' };
    const readers: [string, (r: unknown) => Read<EdgeResolution>, boolean][] = [
      ['readNodeResolution', (r) => impl.readNodeResolution(node('n', { resolution: r })), true],
      [
        'readEdgeResolution',
        (r) => impl.readEdgeResolution(edge('a', 'b', { resolution: r })),
        false,
      ],
    ];
    describe.each(readers)('%s', (_name, read, isNode) => {
      it.each([[undefined], [null]])('%s is absent', (r) => {
        expect(read(r)).toEqual({ state: 'absent' });
      });
      it.each([
        ['status and resolvedBy only', ok, ok],
        [
          'unknown status is legal (I-13)',
          { ...ok, status: 'speculative' },
          { ...ok, status: 'speculative' },
        ],
        ['confidence 0', { ...ok, confidence: 0 }, { ...ok, confidence: 0 }],
        [
          'confidence 1 and reason',
          { ...ok, confidence: 1, reason: 'builtin' },
          { ...ok, confidence: 1, reason: 'builtin' },
        ],
        ['confidence null counts as absent', { ...ok, confidence: null }, ok],
        // D5 rationale (store readback returns null for a missing property) applied to reason; spec is silent, flagged in report.
        ['reason null counts as absent', { ...ok, reason: null }, ok],
        ['extra keys are stripped', { ...ok, junk: true }, ok],
      ])('%s is present', (_n, stored, want) => {
        expect(read(stored)).toEqual({ state: 'present', value: want });
      });
      it.each([
        ['empty object', {}],
        ['missing resolvedBy', { status: 'resolved' }],
        ['missing status', { resolvedBy: 'lsp' }],
        ['empty status', { ...ok, status: '' }],
        ['empty resolvedBy', { ...ok, resolvedBy: '' }],
        ['status a number', { ...ok, status: 5 }],
        ['resolvedBy an object', { ...ok, resolvedBy: {} }],
        ['confidence above 1', { ...ok, confidence: 1.2 }],
        ['confidence below 0', { ...ok, confidence: -0.1 }],
        ['confidence NaN', { ...ok, confidence: Number.NaN }],
        ['confidence a string', { ...ok, confidence: '0.5' }],
        ['reason a number', { ...ok, reason: 3 }],
        ['an array', []],
        ['a string', 'resolved'],
        ['a number', 7],
      ])('%s is malformed-resolution', (_n, stored) => {
        const got = read(stored);
        expect(got).toMatchObject({ state: 'malformed', defect: { code: 'malformed-resolution' } });
        // A node reader names the node; an edge reader has no locator (validatePayload adds edgeIndex).
        expect('defect' in got ? got.defect.nodeId : 'no defect').toBe(isNode ? 'n' : undefined);
      });
    });
  });

  // Controller decision 108 (a C-MODEL amendment): with no data.location, the code tier's schema
  // properties are the location. The range string is 04-schema.yaml's (lines 1-based, columns 0-based,
  // the ladder's `1:0-3:0` for a two-line file), read back exactly as formatRange writes it.
  describe(`${name} C-MODEL I-14 decision 108: file and range when data.location is absent`, () => {
    const read = (data: Record<string, unknown>) => impl.readNodeLocation(code(data));

    it.each([
      ['only a file', node('n', { file: 'pkg/m.py' })],
      ['a null range and an undefined name_range', code({ range: null, name_range: undefined })],
      ['a null location beside them', code({ location: null, range: null })],
    ])('%s is absent', (_n, n) => {
      expect(impl.readNodeLocation(n)).toEqual({ state: 'absent' });
    });

    it.each([
      ["the ladder's two-line MODULE", { range: '1:0-3:0' }, at(0, 0, 2, 0)],
      ['an empty file', { range: '1:0-1:0' }, at(0, 0, 0, 0)],
      ['columns as written, lines minus one', { range: '12:30-104:7' }, at(11, 30, 103, 7)],
      ['one line', { range: '3:2-3:5' }, at(2, 2, 2, 5)],
      [
        'safe integers at the top',
        { range: `${MAX}:${MAX}-${MAX}:${MAX}` },
        at(MAX - 1, MAX, MAX - 1, MAX),
      ],
      ['a null location', { location: null, range: '2:0-4:1' }, at(1, 0, 3, 1)],
    ])('%s is present at its range', (_n, data, want) => {
      const got = read({ revision_id: 'r', name: 'm', ...data });
      expect(got).toStrictEqual({ state: 'present', value: { filePath: 'pkg/m.py', range: want } });
    });

    it('name_range is the nameRange; a null one is none', () => {
      expect(read({ range: '1:0-9:0', name_range: '2:4-2:9' })).toStrictEqual({
        state: 'present',
        value: { filePath: 'pkg/m.py', range: at(0, 0, 8, 0), nameRange: at(1, 4, 1, 9) },
      });
      expect(read({ range: '1:0-9:0', name_range: null })).toStrictEqual({
        state: 'present',
        value: { filePath: 'pkg/m.py', range: at(0, 0, 8, 0) },
      });
    });

    it.each([
      ['line 0', '0:0-1:0'],
      ['end line 0', '1:0-0:0'],
      ['end line before start', '2:0-1:5'],
      ['end column before start on one line', '2:5-2:4'],
      ['a leading zero in a line', '01:0-1:0'],
      ['a leading zero in a column', '1:00-1:1'],
      ['a sign', '+1:0-1:0'],
      ['a minus', '-1:0-1:0'],
      ['a space after', '1:0-1:0 '],
      ['a space before', ' 1:0-1:0'],
      ['a newline after', '1:0-1:0\n'],
      ['colons only', '1:0:1:0'],
      ['dashes only', '1-0-1-0'],
      ['three numbers', '1:0-1'],
      ['five numbers', '1:0-1:0-2'],
      ['empty', ''],
      ['a fraction', '1.0:0-1:0'],
      ['an exponent', '1e1:0-1e1:0'],
      ['a line past the safe integers', `${MAX + 1}:0-${MAX + 1}:0`],
      ['a column past the safe integers', `1:0-1:${MAX + 1}`],
      // Post-implementation (sabotage): a start column the end, on a later line, does not bound.
      ['a start column past the safe integers', `1:${MAX + 1}-2:0`],
      ['a non-ASCII digit', '1:0-1:٣'],
      ['a SourceRange object (the extractor form)', at(0, 0, 2, 0)],
      ['a number', 5],
      ['an array', ['1:0-2:0']],
      // Round two (review 6): falsy but present.
      ['zero', 0],
      ['false', false],
    ])('range: %s is malformed', (_n, text) => {
      expect(read({ range: text })).toStrictEqual(badKey('range'));
    });

    it.each([
      ['missing', { file: undefined }],
      ['null', { file: null }],
      ['the root', { file: '.' }],
      ['absolute', { file: '/w/pkg/m.py' }],
      ['climbing', { file: '../m.py' }],
      ['empty', { file: '' }],
      ['a number', { file: 5 }],
      // Round two (review 7): what only isWorkspacePath refuses.
      ['dot-slash', { file: './m.py' }],
      ['an empty segment', { file: 'a//b.py' }],
      ['a .. segment', { file: 'a/../b.py' }],
      ['a trailing slash', { file: 'a/' }],
      ['a NUL', { file: 'a\u0000b.py' }],
    ])('file: %s is malformed', (_n, data) => {
      expect(read({ range: '1:0-2:0', ...data })).toStrictEqual(badKey('file'));
    });

    it.each([
      ['line 0', '0:0-1:0'],
      ['reversed', '2:9-2:4'],
      ['not a range', 'name'],
      ['a SourceRange object', at(1, 4, 1, 9)],
      ['a number', 7],
      // Round two (review 6): falsy but present.
      ['empty', ''],
      ['zero', 0],
      ['false', false],
    ])('name_range: %s is malformed', (_n, nameRange) => {
      expect(read({ range: '1:0-2:0', name_range: nameRange })).toStrictEqual(badKey('name_range'));
    });

    // Round two (review 8): the id is JSON, as data.location's detail has it.
    it('names the node by its id in JSON', () => {
      const quoted = impl.readNodeLocation(node('a"b', { file: 'pkg/m.py', range: 'x' }));
      expect(quoted).toStrictEqual({
        state: 'malformed',
        defect: {
          code: 'malformed-location',
          detail: 'node "a\\"b" data.range is malformed',
          nodeId: 'a"b',
        },
      });
    });

    it('names the first key that fails: range, then file, then name_range', () => {
      expect(read({ name_range: '1:0-1:3' })).toStrictEqual(badKey('range'));
      expect(read({ range: 'x', file: '.' })).toStrictEqual(badKey('range'));
      expect(read({ range: '1:0-2:0', file: '.', name_range: 'x' })).toStrictEqual(badKey('file'));
    });

    it('a data.location wins: present or malformed, the schema properties are not read', () => {
      const location = { filePath: 'src/x.ts', range };
      expect(read({ location, range: 'x', file: '.' })).toStrictEqual({
        state: 'present',
        value: location,
      });
      expect(read({ location: { filePath: 'src/x.ts' }, range: '1:0-2:0' })).toMatchObject({
        state: 'malformed',
        defect: { detail: 'node "n" data.location is malformed' },
      });
    });

    it('validatePayload reports a malformed range as malformed-location at its index', () => {
      const p = payload([
        node('ok', { file: 'pkg/m.py', range: '1:0-2:0' }),
        code({ range: '0:0-1:0' }),
      ]);
      expect(impl.validatePayload(p)).toEqual([{ ...badKey('range').defect, nodeIndex: 1 }]);
    });
  });

  describe(`${name} C-MODEL seq`, () => {
    it.each([[-2], [Number.NaN], [1.5], [Number.POSITIVE_INFINITY], ['3']])(
      'seq %s is non-monotonic-seq with no nodeId',
      (seq) => {
        const defects = impl.validatePayload(Object.assign(payload([]), { seq }));
        expect(defects).toHaveLength(1);
        expect(defects[0]).toMatchObject({ code: 'non-monotonic-seq' });
        expect(defects.at(0)?.nodeId).toBeUndefined();
      },
    );
    it('emits exactly one non-monotonic-seq when seq is both malformed and below previousSeq', () => {
      expect(codes(payload([], [], -2), 5)).toEqual(['non-monotonic-seq']);
    });
    it('accepts an empty payload at seq -1', () => {
      expect(codes(payload([]))).toEqual([]);
    });
    it.each([
      [4, 5, ['non-monotonic-seq']],
      [5, 5, []],
      [6, 5, []],
    ] as const)('payload seq %s against previousSeq %s', (seq, previousSeq, want) => {
      expect(codes(payload([], [], seq), previousSeq)).toEqual(want);
    });
    it('a NaN previousSeq adds no defect', () => {
      expect(codes(payload([], [], 3), Number.NaN)).toEqual([]);
    });
  });

  describe(`${name} C-MODEL defect order`, () => {
    it('is: seq, then nodes by index, then edges by index, in the documented sub-order', () => {
      const bad = { location: 'src', resolution: {} };
      const p = payload(
        [node(`a${NUL}x`, bad), node('b'), node('b', { location: 'src' }), node('')],
        [edge('b', 'zz', { resolution: {} }), edge('', 'q'), edge('x', '')],
        -2,
      );
      expect(impl.validatePayload(p)).toMatchObject([
        { code: 'non-monotonic-seq' },
        { code: 'id-contains-separator', nodeIndex: 0 },
        { code: 'malformed-location', nodeIndex: 0 },
        { code: 'malformed-resolution', nodeIndex: 0 },
        { code: 'duplicate-node-id', nodeIndex: 2 },
        { code: 'malformed-location', nodeIndex: 2 },
        { code: 'empty-id', nodeIndex: 3 },
        { code: 'dangling-edge', edgeIndex: 0, endpoint: 'target', nodeId: 'zz' },
        { code: 'malformed-resolution', edgeIndex: 0 },
        { code: 'empty-id', edgeIndex: 1, endpoint: 'source' },
        { code: 'dangling-edge', edgeIndex: 1, endpoint: 'target', nodeId: 'q' },
        // D13: target id defect precedes dangling source (a per-endpoint order would swap these two).
        { code: 'empty-id', edgeIndex: 2, endpoint: 'target' },
        { code: 'dangling-edge', edgeIndex: 2, endpoint: 'source', nodeId: 'x' },
      ]);
    });
    it('reports a non-string node id as empty-id with no nodeId', () => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON from outside.
      const bad = { id: 7, type: 'METHOD' } as unknown as GraphNode;
      const defects = impl.validatePayload(payload([bad]));
      expect(defects).toMatchObject([{ code: 'empty-id', nodeIndex: 0 }]);
      expect(defects.at(0)?.nodeId).toBeUndefined();
    });
    it('orders id-contains-separator before duplicate-node-id within one node (D13), and counts every occurrence (V-2)', () => {
      const id = `a${NUL}`;
      expect(impl.validatePayload(payload([node(id), node(id)]))).toMatchObject([
        { code: 'id-contains-separator', nodeIndex: 0 },
        { code: 'id-contains-separator', nodeIndex: 1 },
        { code: 'duplicate-node-id', nodeIndex: 1, nodeId: id },
      ]);
    });
    it('reports a repeated empty id as empty-id on each node plus one duplicate-node-id', () => {
      expect(codes(payload([node(''), node('')]))).toEqual([
        'empty-id',
        'empty-id',
        'duplicate-node-id',
      ]);
    });
    it('does not read edge.data.location (only node locations are contract)', () => {
      const p = payload([node('a'), node('b')], [edge('a', 'b', { location: 'garbage' })]);
      expect(impl.validatePayload(p)).toEqual([]);
    });
    it('reports a non-string id as empty-id without throwing, and not also as dangling', () => {
      const defects = impl.validatePayload(payload([node('a')], [edge(7, 'a')]));
      expect(defects).toMatchObject([{ code: 'empty-id', edgeIndex: 0, endpoint: 'source' }]);
      expect(defects.at(0)?.nodeId).toBeUndefined();
    });
  });
}

verifyModelContract('@cpg/model', {
  applyGraphDelta,
  validatePayload,
  readNodeLocation,
  readNodeResolution,
  readEdgeResolution,
});
