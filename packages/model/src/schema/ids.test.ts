/**
 * U1.1.3: makeNodeId / parseNodeId. Expected strings come from 04-schema.yaml id_rule and the U1.1.3 design doc,
 * never from running the code. The bodyHash and DIRECTORY examples (`:#deadbeef`, `dir:src`, `dir:.`) are NOT in
 * 04-schema.yaml yet: the design doc specifies them and the implementer must add them to 04-schema in this PR.
 */
import { describe, expect, it } from 'vitest';

import type { WorkspacePath } from '../paths';
import { MODULE_SCOPE, makeNodeId, parseNodeId, type NodeIdParts } from './ids';
import { NODE_LABELS, nodeSpec, type NodeLabel } from './index';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only brand forge.
const wp = (s: string): WorkspacePath => s as WorkspacePath;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only: forge invalid parts to prove the runtime guard.
const forge = (p: unknown): NodeIdParts => p as NodeIdParts;

describe('04-schema id_rule examples', () => {
  const rows: [string, NodeIdParts, string][] = [
    ['FILE', { form: 'file', path: wp('src/users.ts') }, 'file:src/users.ts'],
    [
      'MODULE',
      { form: 'scoped', path: wp('src/users.ts'), kind: 'MODULE', scope: [MODULE_SCOPE] },
      'file:src/users.ts:MODULE:$root',
    ],
    [
      'TYPE_DECL',
      { form: 'scoped', path: wp('src/users.ts'), kind: 'TYPE_DECL', scope: ['UserService'] },
      'file:src/users.ts:TYPE_DECL:UserService',
    ],
    [
      'METHOD',
      {
        form: 'scoped',
        path: wp('src/users.ts'),
        kind: 'METHOD',
        scope: ['UserService', 'findById'],
      },
      'file:src/users.ts:METHOD:UserService.findById',
    ],
    [
      'CALL',
      {
        form: 'scoped',
        path: wp('src/users.ts'),
        kind: 'CALL',
        scope: ['UserService', 'findById'],
        ordinal: 0,
      },
      'file:src/users.ts:CALL:UserService.findById:0',
    ],
    [
      'bodyHash (anonymous item)',
      {
        form: 'scoped',
        path: wp('src/a.ts'),
        kind: 'METHOD',
        scope: ['f'],
        bodyHash: 'deadbeef',
      },
      'file:src/a.ts:METHOD:f:#deadbeef',
    ],
    ['DIRECTORY', { form: 'directory', path: wp('src') }, 'dir:src'],
    ['DIRECTORY root', { form: 'directory', path: wp('.') }, 'dir:.'],
  ];

  it.each(rows)('%s mints to the spec string', (_n, parts, id) => {
    expect(makeNodeId(parts)).toBe(id);
  });
  it.each(rows)('%s parses back to the same parts', (_n, parts, id) => {
    expect(parseNodeId(id)).toStrictEqual(parts);
  });
});

describe('escaping (D-7) and suffix disambiguation (D-5)', () => {
  const rows: [string, NodeIdParts, string][] = [
    ['colon and percent in path', { form: 'file', path: wp('C:x/a%b.ts') }, 'file:C%3Ax/a%25b.ts'],
    [
      'dot in a scope segment',
      { form: 'scoped', path: wp('a.ts'), kind: 'METHOD', scope: ['[Symbol.iterator]'] },
      'file:a.ts:METHOD:[Symbol%2Eiterator]',
    ],
    [
      'percent in a scope segment escapes to %25',
      { form: 'scoped', path: wp('a.ts'), kind: 'METHOD', scope: ['a%'] },
      'file:a.ts:METHOD:a%25',
    ],
    ['dot in path is NOT escaped', { form: 'file', path: wp('a.b/c.ts') }, 'file:a.b/c.ts'],
    [
      'angle-bracket name is not escaped',
      { form: 'scoped', path: wp('a.ts'), kind: 'METHOD', scope: ['<lambda>'] },
      'file:a.ts:METHOD:<lambda>',
    ],
    [
      'segment starting with #',
      { form: 'scoped', path: wp('a.ts'), kind: 'METHOD', scope: ['#x'] },
      'file:a.ts:METHOD:#x',
    ],
    [
      '$root under a non-MODULE kind',
      { form: 'scoped', path: wp('a.ts'), kind: 'METHOD', scope: ['$root'] },
      'file:a.ts:METHOD:$root',
    ],
    [
      'ordinal 0',
      { form: 'scoped', path: wp('a.ts'), kind: 'CALL', scope: ['f'], ordinal: 0 },
      'file:a.ts:CALL:f:0',
    ],
    [
      'all-digit bodyHash stays a bodyHash',
      { form: 'scoped', path: wp('a.ts'), kind: 'METHOD', scope: ['f'], bodyHash: '12345678' },
      'file:a.ts:METHOD:f:#12345678',
    ],
  ];
  it.each(rows)('%s', (_n, parts, id) => {
    expect(makeNodeId(parts)).toBe(id);
    expect(parseNodeId(id)).toStrictEqual(parts);
  });

  it('a FILE named like a scoped id does not collide with that scoped id', () => {
    const file = makeNodeId({ form: 'file', path: wp('a:METHOD:b') });
    const scoped = makeNodeId({ form: 'scoped', path: wp('a'), kind: 'METHOD', scope: ['b'] });
    expect(file).toBe('file:a%3AMETHOD%3Ab');
    expect(scoped).toBe('file:a:METHOD:b');
  });
});

describe('every label the rule addresses round-trips', () => {
  // Typed Record: adding a label to NODE_LABELS fails compilation until it is classified.
  const ID_FORM: Record<NodeLabel, 'file' | 'directory' | 'scoped' | 'not-id-rule'> = {
    DIRECTORY: 'directory',
    FILE: 'file',
    MODULE: 'scoped',
    TYPE_DECL: 'scoped',
    METHOD: 'scoped',
    PARAM: 'scoped',
    MEMBER: 'scoped',
    CALL: 'scoped',
    IMPORT: 'scoped',
    UNKNOWN: 'scoped',
    SYMBOL: 'not-id-rule', // key is fqn (SCIP descriptor)
    TAG: 'not-id-rule', // key is name
    META_DATA: 'not-id-rule', // key is []
    COMMUNITY: 'not-id-rule', // overlay, no file property
  };

  it('classification agrees with the registry: scoped iff key is [id] and has a file property', () => {
    for (const spec of NODE_LABELS) {
      const idRuleShaped = spec.key.length === 1 && spec.key[0] === 'id' && spec.hasFileProperty;
      expect(ID_FORM[spec.label] === 'scoped').toBe(idRuleShaped);
    }
  });

  const scopedLabels = NODE_LABELS.map((n) => n.label).filter((l) => ID_FORM[l] === 'scoped');
  it.each(scopedLabels)('%s mints and round-trips', (label) => {
    const parts: NodeIdParts = {
      form: 'scoped',
      path: wp('src/a.ts'),
      kind: label,
      scope: ['A', 'b'],
      ordinal: 2,
    };
    expect(makeNodeId(parts)).toBe(`file:src/a.ts:${label}:A.b:2`);
    expect(parseNodeId(`file:src/a.ts:${label}:A.b:2`)).toStrictEqual(parts);
  });
});

describe('ID-7 prefix ownership', () => {
  it('a scoped id starts with its FILE id plus a colon', () => {
    const path = wp('src/users.ts');
    const id = makeNodeId({ form: 'scoped', path, kind: 'METHOD', scope: ['f'] });
    expect(id.startsWith(makeNodeId({ form: 'file', path }) + ':')).toBe(true);
  });
  it('holds for a path needing escapes', () => {
    const path = wp('C:x/a%b.ts');
    const id = makeNodeId({ form: 'scoped', path, kind: 'METHOD', scope: ['f'] });
    expect(id.startsWith(makeNodeId({ form: 'file', path }) + ':')).toBe(true);
  });
});

describe('parseNodeId rejects malformed ids with undefined, never throwing', () => {
  const malformed = [
    '',
    'file:',
    'dir:',
    'x:a.ts',
    'file:a.ts:METHOD',
    'file:a.ts:METHOD:',
    'file:a.ts:METHOD:a..b',
    'file:a.ts:METHOD:f:',
    'file:a.ts:METHOD:f:01',
    'file:a.ts:METHOD:f:#',
    'file:a.ts:METHOD:f:#AB',
    'file:a.ts:METHOD:f:1:2',
    'dir:a:X:y',
    'file:a%3a.ts', // lowercase escape is non-canonical
    'file:a%41.ts', // needless escape
    'file:a%.ts',
    'file:./a.ts',
    // ordinal limits and non-canonical numerals (spec: canonical decimal, safe integer)
    'file:a.ts:CALL:f:9007199254740992',
    'file:a.ts:CALL:f:1e3',
    'file:a.ts:CALL:f:+1',
    'file:a.ts:CALL:f:-1',
    'file:a.ts:CALL:f:0x1',
    'file:a.ts:CALL:f: 1',
    'file:a.ts:CALL:f:Infinity',
    // bodyHash limits: 1..64 lowercase hex
    `file:a.ts:METHOD:f:#${'a'.repeat(65)}`,
    'file:a.ts:METHOD:f:#abz',
    'file:a.ts:METHOD:f:#ab:c',
    // path checking in parse (same rules as make)
    'file:/a.ts',
    'file:a//b.ts',
    'file:a/',
    'file:../a.ts',
    'file:.:METHOD:f',
    'dir:./a',
    'dir:a/',
    'file:a%3',
    'file:a%2Eb', // only % and : are escaped in a path
    'file:a%2Fb',
    'file:a.ts:method:f',
    'file:a.ts:FILE:f',
    'file:a.ts:DIRECTORY:f',
    'file:a.ts::f', // empty kind
    'file:a.ts:METHOD:.a', // leading empty segment
    'file:a.ts:METHOD:a.', // trailing empty segment
    // escapes inside scope segments must be canonical too (only %2E and %25 are valid there; uppercase hex)
    'file:a.ts:METHOD:a%2eb',
    'file:a.ts:METHOD:a%41',
    'file:a.ts:METHOD:a%3a',
    'file:a.ts:METHOD:a%',
    'file:a.ts:METHOD:a%3',
    'file:.',
    'file:a\u0000b.ts',
    'file:a.ts:METHOD:f\u0000',
    '__root__', // VIRTUAL_ROOT_ID
    '`src/a.ts`/A#b().', // SYMBOL fqn
  ];
  it.each(malformed)('%j', (id) => {
    let result: NodeIdParts | undefined = forge({ sentinel: true });
    expect(() => {
      result = parseNodeId(id);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });
});

describe('makeNodeId throws on invalid parts', () => {
  const ok = { form: 'scoped', path: wp('a.ts'), kind: 'METHOD', scope: ['f'] } as const;
  const bad: [string, unknown][] = [
    ['empty path', { form: 'file', path: '' }],
    ['non-normalised path a//b', { form: 'file', path: 'a//b' }],
    ['leading ./ path', { form: 'file', path: './a' }],
    ['FILE path "."', { form: 'file', path: '.' }],
    ['scoped path "."', { ...ok, path: '.' }],
    ['scoped path a//b', { ...ok, path: 'a//b' }],
    ['scoped absolute path', { ...ok, path: '/a.ts' }],
    ['directory empty path', { form: 'directory', path: '' }],
    ['directory path a//b', { form: 'directory', path: 'a//b' }],
    ['directory path ./a', { form: 'directory', path: './a' }],
    ['directory NUL in path', { form: 'directory', path: 'a\u0000b' }],
    ['NUL in path', { form: 'file', path: 'a\u0000b' }],
    ['empty scope', { ...ok, scope: [] }],
    ['empty segment', { ...ok, scope: ['a', ''] }],
    ['NUL in segment', { ...ok, scope: ['a\u0000'] }],
    ['empty kind', { ...ok, kind: '' }],
    ['lowercase kind', { ...ok, kind: 'method' }],
    ['digit-leading kind', { ...ok, kind: '1A' }],
    ['kind with trailing junk A:B', { ...ok, kind: 'A:B' }],
    ['kind with hyphen A-B', { ...ok, kind: 'A-B' }],
    ['kind with dot A.B', { ...ok, kind: 'A.B' }],
    ['kind with trailing lowercase METHODx', { ...ok, kind: 'METHODx' }],
    ['kind FILE', { ...ok, kind: 'FILE' }],
    ['kind DIRECTORY', { ...ok, kind: 'DIRECTORY' }],
    ['ordinal -1', { ...ok, ordinal: -1 }],
    ['ordinal 1.5', { ...ok, ordinal: 1.5 }],
    ['ordinal NaN', { ...ok, ordinal: Number.NaN }],
    ['ordinal 2**53', { ...ok, ordinal: 2 ** 53 }],
    ['empty bodyHash', { ...ok, bodyHash: '' }],
    ['uppercase bodyHash', { ...ok, bodyHash: 'ABC' }],
    ['non-hex bodyHash', { ...ok, bodyHash: 'xyz' }],
    ['bodyHash bad at the end abz', { ...ok, bodyHash: 'abz' }],
    ['bodyHash with colon ab:c', { ...ok, bodyHash: 'ab:c' }],
    ['unknown form symbol', { form: 'symbol', fqn: 'x' }],
    ['absolute path', { form: 'file', path: '/a.ts' }],
    ['.. path', { form: 'file', path: '../a.ts' }],
    ['.. path segment', { form: 'file', path: 'a/../b.ts' }],
    ['trailing slash path', { form: 'file', path: 'a/' }],
    ['scope element not a string', { ...ok, scope: [1] }],
    ['65-char bodyHash', { ...ok, bodyHash: 'a'.repeat(65) }],
    ['ordinal and bodyHash together', { ...ok, ordinal: 1, bodyHash: 'ab' }],
  ];
  it.each(bad)('%s', (_n, parts) => {
    expect(() => makeNodeId(forge(parts))).toThrow(/^invalid node id parts:/);
  });

  it('accepts the boundaries: ordinal 2**53-1 and a 64-char bodyHash', () => {
    expect(makeNodeId({ ...ok, ordinal: Number.MAX_SAFE_INTEGER })).toBe(
      'file:a.ts:METHOD:f:9007199254740991',
    );
    expect(makeNodeId({ ...ok, bodyHash: 'a'.repeat(64) })).toBe(
      `file:a.ts:METHOD:f:#${'a'.repeat(64)}`,
    );
  });
});

describe('ND-10 statement-level identity', () => {
  const stmt: NodeIdParts = {
    form: 'scoped',
    path: wp('x.py'),
    kind: 'STMT',
    scope: ['main'],
    ordinal: 3,
  };

  it('mints and round-trips a synthetic STMT id', () => {
    expect(makeNodeId(stmt)).toBe('file:x.py:STMT:main:3');
    expect(parseNodeId('file:x.py:STMT:main:3')).toStrictEqual(stmt);
  });

  it('STMT is not a schema label, so the registry does not foreclose or define it', () => {
    expect(nodeSpec('STMT')).toBeUndefined();
  });

  type Model = { path: string; functions: { name: string; statements: string[] }[] };
  // Test scaffolding: ordinal = index within the enclosing function (parent-scope-relative, 04-schema ordinal_rule).
  const stmtIds = (m: Model): string[] =>
    m.functions.flatMap((f) =>
      f.statements.map((_s, i) =>
        makeNodeId({
          form: 'scoped',
          path: wp(m.path),
          kind: 'STMT',
          scope: [f.name],
          ordinal: i,
        }),
      ),
    );
  // Contrast rule: file-relative counter. Must NOT be stable; proves the assertion below discriminates.
  const stmtIdsFileRelative = (m: Model): string[] =>
    m.functions
      .flatMap((f) => f.statements.map(() => f.name))
      .map((name, i) =>
        makeNodeId({ form: 'scoped', path: wp(m.path), kind: 'STMT', scope: [name], ordinal: i }),
      );

  const main = { name: 'main', statements: ['a', 'b', 'c', 'd'] };
  const before: Model = { path: 'x.py', functions: [main] };
  // helper inserted ABOVE main, with an extra statement appended inside helper.
  const after: Model = {
    path: 'x.py',
    functions: [{ name: 'helper', statements: ['p', 'q', 'r'] }, main],
  };

  it('inserting an unrelated function above leaves every main STMT id unchanged', () => {
    const b = stmtIds(before);
    const a = stmtIds(after);
    expect(b).toEqual([
      'file:x.py:STMT:main:0',
      'file:x.py:STMT:main:1',
      'file:x.py:STMT:main:2',
      'file:x.py:STMT:main:3',
    ]);
    expect(b.filter((id) => !a.includes(id))).toEqual([]); // nothing removed
    expect(a.filter((id) => !b.includes(id))).toEqual([
      'file:x.py:STMT:helper:0',
      'file:x.py:STMT:helper:1',
      'file:x.py:STMT:helper:2',
    ]); // exactly helper's ids added
  });

  it('a file-relative counter would churn main ids, so the stability check is not vacuous', () => {
    const b = stmtIdsFileRelative(before);
    const a = stmtIdsFileRelative(after);
    expect(b.filter((id) => !a.includes(id)).length).toBeGreaterThan(0);
  });
  // Documented boundary (not asserted away): inserting a statement INSIDE main above statement 3 shifts later
  // ordinals. That is the rule's stated cost, same as CALL's.
});
