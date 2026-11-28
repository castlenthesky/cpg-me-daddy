// The Python import table on real trees (the pinned wasm grammar), BMO-134: what `classifyExpression`
// says about an import statement. Expected values come from python.ts's contract for classifyImport
// (archive 21754b4 imports.ts: one binding per bound name, module dotted with leading dots stripped,
// relativeDepth the dot count, `imported` absent for a whole-module import, `*` for a wildcard),
// C-EXTRACT's RefSite (`importBinding`) and I20 (the ref token is the IMPORTED name, never the alias),
// decision 94 (exported = no leading underscore) and the IMPORT schema (source_text, imported_names,
// alias, is_type_only). Positions are counted by hand from each source (0-based rows, UTF-16 columns).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isWorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExpressionVerdict, SyntaxNode } from './contract';
import { pythonAdapter } from './python';

const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
const registry = createLanguageRegistry();
for (const r of BUILTIN_LANGUAGES) registry.register(r);
registry.freeze();
const service = createParseService({
  registry,
  source: {
    describe: () => WASM_DIR,
    load: async (ref) => ({
      ok: true,
      bytes: new Uint8Array(await readFile(join(WASM_DIR, ref.wasmFile))),
      origin: ref.wasmFile,
    }),
  },
});
afterAll(() => service.dispose());

/** A node as `text@row:col`. */
const at = (node: SyntaxNode) =>
  `${node.text}@${String(node.startPosition.row)}:${String(node.startPosition.column)}`;

/** An ImportInfo with each binding as `[nameNode, nameParts joined by spaces, binding, exported]`. */
function summary(verdict: ExpressionVerdict | undefined): unknown {
  if (verdict?.emits !== 'IMPORT') return verdict;
  return {
    ...verdict,
    bindings: verdict.bindings.map((b) => [
      at(b.nameNode),
      b.nameParts.join(' '),
      b.binding,
      b.exported,
    ]),
  };
}

/** Classifies the first statement of `source` and projects the verdict, releasing the tree after. */
async function classifyFirst<T>(
  source: string,
  project: (verdict: ExpressionVerdict | undefined) => T,
): Promise<T> {
  const path = 'main.py';
  if (!isWorkspacePath(path)) throw new Error('not a workspace path');
  const parsed = await service.parse({ key: path, text: `${source}\n` });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    const first = parsed.handle.root.namedChildren[0];
    if (first === undefined) throw new Error('no statement');
    return project(pythonAdapter.classifyExpression?.(first));
  } finally {
    parsed.handle.release();
  }
}

/** One binding: its token, nameParts, then importBinding's fields; `imported` absent when undefined. */
const bind = (
  token: string,
  parts: string,
  module: string,
  relativeDepth: number,
  local: string,
  imported?: string,
  exported = true,
) => [
  token,
  parts,
  { module, relativeDepth, ...(imported !== undefined ? { imported } : {}), local },
  exported,
];

/** The ImportInfo: never type-only in Python; `alias` absent when undefined. */
const info = (
  sourceText: string,
  importedNames: string[],
  bindings: unknown[],
  alias?: string,
) => ({
  emits: 'IMPORT',
  sourceText,
  importedNames,
  ...(alias !== undefined ? { alias } : {}),
  typeOnly: false,
  bindings,
});

// prettier-ignore
const ROWS: [string, unknown][] = [
  // Whole-module imports: no `imported`, local the first segment unless aliased, imported_names [].
  ['import os', info('os', [], [bind('os@0:7', 'os', 'os', 0, 'os')])],
  ['import os.path', info('os.path', [], [bind('os.path@0:7', 'os path', 'os.path', 0, 'os')])],
  ['import a.b as c, _d', info('a.b,_d', [], [bind('a.b@0:7', 'a b', 'a.b', 0, 'c'), bind('_d@0:17', '_d', '_d', 0, '_d', undefined, false)])],
  ['import numpy as np', info('numpy', [], [bind('numpy@0:7', 'numpy', 'numpy', 0, 'np')], 'np')],
  // exported follows the LOCAL name: `_private` bound as `pub` is exported.
  ['import _private as pub', info('_private', [], [bind('_private@0:7', '_private', '_private', 0, 'pub')], 'pub')],
  // r2 (review 6): alias comes from `as`, and only for a sole binding, wherever the `as` is.
  ['from m import a as a', info('m', ['a'], [bind('a@0:14', 'a', 'm', 0, 'a', 'a')], 'a')],
  ['import a, b as c', info('a,b', [], [bind('a@0:7', 'a', 'a', 0, 'a'), bind('b@0:10', 'b', 'b', 0, 'c')])],
  // From-imports: imported as the module spells it, the token is the imported name, not the alias.
  ['from m import a', info('m', ['a'], [bind('a@0:14', 'a', 'm', 0, 'a', 'a')])],
  ['from m import a as b, _c', info('m', ['a', '_c'], [bind('a@0:14', 'a', 'm', 0, 'b', 'a'), bind('_c@0:22', '_c', 'm', 0, '_c', '_c', false)])],
  ['from m import a as _b', info('m', ['a'], [bind('a@0:14', 'a', 'm', 0, '_b', 'a', false)], '_b')],
  // Post-implementation (sabotage #9): a from-import's alias also needs a sole binding.
  ['from m import a, b as c', info('m', ['a', 'b'], [bind('a@0:14', 'a', 'm', 0, 'a', 'a'), bind('b@0:17', 'b', 'm', 0, 'c', 'b')])],
  ['from m import (a,\n    # c\n    b,)', info('m', ['a', 'b'], [bind('a@0:15', 'a', 'm', 0, 'a', 'a'), bind('b@2:4', 'b', 'm', 0, 'b', 'b')])],
  ['from m import a\\\n  , b', info('m', ['a', 'b'], [bind('a@0:14', 'a', 'm', 0, 'a', 'a'), bind('b@1:4', 'b', 'm', 0, 'b', 'b')])],
  // The module name and the imported name are told apart by position, not by text.
  ['from m import m', info('m', ['m'], [bind('m@0:14', 'm', 'm', 0, 'm', 'm')])],
  // Relative imports: dots counted, then stripped from the module; source_text keeps them.
  ['from . import x', info('.', ['x'], [bind('x@0:14', 'x', '', 1, 'x', 'x')])],
  ['from ..pkg.sub import y', info('..pkg.sub', ['y'], [bind('y@0:22', 'y', 'pkg.sub', 2, 'y', 'y')])],
  ['from ... import x', info('...', ['x'], [bind('x@0:16', 'x', '', 3, 'x', 'x')])],
  ['from . pkg import z', info('.pkg', ['z'], [bind('z@0:18', 'z', 'pkg', 1, 'z', 'z')])],
  // r2 (review 7): the dots are counted, not the prefix's length (`. .` is two).
  ['from . . import x', info('..', ['x'], [bind('x@0:16', 'x', '', 2, 'x', 'x')])],
  // r2 (review 8): a line continuation before the module is no name; the module is the field.
  ['from \\\n m import a', info('m', ['a'], [bind('a@1:10', 'a', 'm', 0, 'a', 'a')])],
  // Names are their identifiers joined by `.`, whatever the spacing.
  ['from a . b import c', info('a.b', ['c'], [bind('c@0:18', 'c', 'a.b', 0, 'c', 'c')])],
  // A wildcard is one binding at the `*`; `exported` (no leading underscore) holds for `*`.
  ['from m import *', info('m', ['*'], [bind('*@0:14', '*', 'm', 0, '*', '*')])],
  ['from __future__ import annotations', info('__future__', ['annotations'], [bind('annotations@0:23', 'annotations', '__future__', 0, 'annotations', 'annotations')])],
  // r2 (review 9): a future import names every binding, aliased ones included.
  ['from __future__ import annotations, division', info('__future__', ['annotations', 'division'], [bind('annotations@0:23', 'annotations', '__future__', 0, 'annotations', 'annotations'), bind('division@0:36', 'division', '__future__', 0, 'division', 'division')])],
  ['from __future__ import annotations as ann', info('__future__', ['annotations'], [bind('annotations@0:23', 'annotations', '__future__', 0, 'ann', 'annotations')], 'ann')],
  // An ERROR inside the statement (`m.`) is no binding; the names around it still are.
  ['from m. import x', info('m', ['x'], [bind('x@0:15', 'x', 'm', 0, 'x', 'x')])],
];

/** A hand-built node at 0:0: `kids` are its named children, `fields` its named fields. */
function fake(
  type: string,
  text: string,
  kids: readonly SyntaxNode[] = [],
  fields: Readonly<Record<string, SyntaxNode>> = {},
): SyntaxNode {
  return {
    type,
    text,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: text.length },
    startIndex: 0,
    endIndex: text.length,
    namedChildren: kids,
    childForFieldName: (name) => fields[name] ?? null,
  };
}
const dotted = (name: string) => fake('dotted_name', name, [fake('identifier', name)]);

describe('the import table (BMO-134; archive 21754b4 imports.ts)', () => {
  it.each(ROWS)('%j', async (source, want) => {
    expect(await classifyFirst(source, summary)).toStrictEqual(want);
  });

  // Post-implementation (sabotage #7, #16): python.ts's reading S42-7. A MISSING identifier is no
  // segment, a name with none is no binding, a statement with no binding is no IMPORT. The trees are
  // PRECONDITIONS: `(import_from_statement module_name: (dotted_name (identifier)) name: (dotted_name
  // (MISSING identifier)))` and the same with `(relative_import (import_prefix))`.
  it.each(['from m import ()', 'from . import (,)'])(
    '%j (one MISSING name) is no import',
    async (source) => {
      expect(await classifyFirst(source, (v) => v)).toBeUndefined();
    },
  );

  // Post-implementation (sabotage #17): an empty alias is a MISSING local name, so no binding. The real
  // grammar gives an ERROR for `import a as`, so the tree is hand-built.
  it('drops a binding whose alias is empty and keeps the others', () => {
    const empty = fake('aliased_import', 'a as', [dotted('a'), fake('identifier', '')], {
      name: dotted('a'),
      alias: fake('identifier', ''),
    });
    const statement = fake('import_statement', 'import a as, b', [empty, dotted('b')]);
    expect(summary(pythonAdapter.classifyExpression?.(statement))).toStrictEqual(
      info('b', [], [bind('b@0:0', 'b', 'b', 0, 'b')]),
    );
  });

  // A guard (passes at RED too): a statement that only mentions a module is no import.
  it('is undefined for every other statement (sparse by design)', async () => {
    const got = await Promise.all(
      ['x = 1', 'f(os)', 'del os', 'global os', 'os.path'].map(async (s) =>
        classifyFirst(s, (v) => v),
      ),
    );
    expect(got).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
