// Pass B's imports (BMO-134) on real trees (the pinned wasm grammar) through createExtractor. Expected
// values come from the spec, never from running the code: IMPORT ids and ordinals from controller
// decision 92 ("IMPORT:<scope>:<n> the same way" as CALL: the enclosing METHOD's scope or `$root`,
// every IMPORT of the region in pre-order; a nested def/class in a body is not descended) and the
// schema's ordinal_rule; "one per import statement" and its properties from the IMPORT schema; DECLARES
// as lexical nesting (schema: DECLARES MODULE|TYPE_DECL|METHOD -> IMPORT); one ref site per bound name
// at the imported token from the RefSite contract, I20 and archive refSites.ts importSites; re-exports
// in interfaceHash from decision 94 (Python exported = a top-level name with no leading underscore);
// I21 and decision 95 for truncation and ERRORs. Rows are 0-based, columns UTF-16, counted by hand.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { formatRange, isWorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExtractedFile, ExtractOutcome, ExtractRequest } from './contract';
import { createExtractor } from './extractor';

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

const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

/** Parses `source` as main.py and extracts it, releasing the tree whatever happens. */
async function extractPy(
  source: string,
  budget?: ExtractRequest['budget'],
): Promise<ExtractOutcome> {
  const path = 'main.py';
  if (!isWorkspacePath(path)) throw new Error('not a workspace path');
  const parsed = await service.parse({ key: path, text: source });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    return createExtractor().extract({
      path,
      grammarId: parsed.handle.language,
      root: parsed.handle.root,
      revision_id: 'cd'.repeat(32),
      lineCount: source.split('\n').length,
      ...(budget !== undefined ? { budget } : {}),
    });
  } finally {
    parsed.handle.release();
  }
}

async function extractOk(source: string): Promise<ExtractedFile> {
  const outcome = await extractPy(source);
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.file;
}

const id = (rest: string) => `file:main.py:${rest}`;
const imp = (scope: string, n: number) => id(`IMPORT:${scope}:${String(n)}`);

/** Each node of `label` as `<id> <range>`, in node order (I3). */
const nodesOf = (file: ExtractedFile, label: string) =>
  file.nodes.filter((n) => n.label === label).map((n) => `${n.id} ${formatRange(n.range)}`);

/** One import ref site, as the RefSite contract spells it (no `declined`: the resolver answers it). */
const site = (
  importId: string,
  k: number,
  [row, column]: [number, number],
  nameParts: string[],
  importBinding: object,
) => ({
  id: `${importId}#${String(k)}`,
  nodeId: importId,
  filePath: 'main.py',
  kind: 'import',
  position: { row, column },
  nameParts,
  importBinding,
});
const whole = (module: string, local: string) => ({ module, relativeDepth: 0, local });
const from = (module: string, imported: string, local = imported, relativeDepth = 0) => ({
  module,
  relativeDepth,
  imported,
  local,
});

const importSites = (file: ExtractedFile) => file.refSites.filter((s) => s.kind === 'import');

/** Each import site's module and its IMPORT id, for a def `fn` with this body. */
const byModule = async (...body: string[]) =>
  Object.fromEntries(
    importSites(await extractOk(lines('def fn():', ...body))).map((s) => [
      s.importBinding?.module,
      s.nodeId,
    ]),
  );
/** The interfaceHash of a file of these rows. */
const hash = async (...rows: string[]) => (await extractOk(lines(...rows))).interfaceHash;

const FIXTURE = lines(
  'import a', // 0
  'from b import c as d, _e', // 1
  'class K:', // 2
  '    import f', // 3
  '    if TYPE_CHECKING:', // 4
  '        from g import h', // 5
  '    def m(self):', // 6
  '        import i', // 7
  'def fn():', // 8
  '    run()', // 9
  '    import j', // 10
  '    if x:', // 11
  '        from k import l', // 12
  '    go()', // 13
  '    def inner():', // 14
  '        import n', // 15
  'try:', // 16
  '    import p', // 17
  'except ImportError:', // 18
  '    p = None', // 19
  'import q as Q', // 20
);

/** r2 (review 2-5): nested classes, a repeated METHOD, and a class and an ERROR in a METHOD body. */
const NESTED = lines(
  'class Outer:', // 0
  '    class Inner:', // 1
  '        import x', // 2
  '    import y', // 3
  'class P:', // 4
  '    @property', // 5
  '    def v(self):', // 6
  '        import a', // 7
  '    @v.setter', // 8
  '    def v(self, x):', // 9
  '        import b', // 10
  'def fn():', // 11
  '    class Local:', // 12
  '        import o', // 13
  '    x = 1', // 14
  '    import a )', // 15: (ERROR (import_statement ...)) in fn's block
  '    import ok', // 16
);

describe('IMPORT nodes: one per statement Pass B walks, ordinals counted like CALL (decision 92)', () => {
  it('counts per region in pre-order, apart from CALL; never inside a nested def', async () => {
    const file = await extractOk(FIXTURE);
    expect(nodesOf(file, 'IMPORT')).toEqual([
      `${imp('$root', 0)} 1:0-1:8`,
      `${imp('$root', 1)} 2:0-2:24`,
      `${imp('$root', 2)} 4:4-4:12`,
      `${imp('$root', 3)} 6:8-6:23`,
      `${imp('K.m', 0)} 8:8-8:16`,
      `${imp('fn', 0)} 11:4-11:12`,
      `${imp('fn', 1)} 13:8-13:23`,
      `${imp('$root', 4)} 18:4-18:12`,
      `${imp('$root', 5)} 21:0-21:13`,
    ]);
    // The calls of fn keep their own count: an IMPORT between them takes no CALL ordinal.
    expect(nodesOf(file, 'CALL')).toEqual([
      `${id('CALL:fn:0')} 10:4-10:9`,
      `${id('CALL:fn:1')} 14:4-14:8`,
    ]);
  });

  it('DECLARES each from its lexical container (MODULE, TYPE_DECL or METHOD), never a compound statement', async () => {
    const file = await extractOk(FIXTURE);
    const declares = file.edges.filter((e) => e.type === 'DECLARES');
    expect(
      declares.filter((e) => e.to.label === 'IMPORT').map((e) => `${e.from.key} -> ${e.to.key}`),
    ).toEqual([
      `${id('MODULE:$root')} -> ${imp('$root', 0)}`,
      `${id('MODULE:$root')} -> ${imp('$root', 1)}`,
      `${id('TYPE_DECL:K')} -> ${imp('$root', 2)}`,
      `${id('TYPE_DECL:K')} -> ${imp('$root', 3)}`,
      `${id('METHOD:K.m')} -> ${imp('K.m', 0)}`,
      `${id('METHOD:fn')} -> ${imp('fn', 0)}`,
      `${id('METHOD:fn')} -> ${imp('fn', 1)}`,
      `${id('MODULE:$root')} -> ${imp('$root', 4)}`,
      `${id('MODULE:$root')} -> ${imp('$root', 5)}`,
    ]);
    // Pass A's four: MODULE -> K, K -> K.m, MODULE -> fn, MODULE -> p (an except block is no scope).
    expect(declares).toHaveLength(13);
    expect(declares.every((e) => Object.keys(e.properties).length === 0)).toBe(true);
  });

  it('writes source_text, imported_names, alias only for a renamed sole binding, is_type_only, status', async () => {
    const file = await extractOk(FIXTURE);
    const props = (key: string) => file.nodes.find((n) => n.id === key)?.properties;
    const base = { is_type_only: false, status: 'ready' };
    expect(
      [imp('$root', 0), imp('$root', 1), imp('fn', 1), imp('$root', 5)].map(props),
    ).toStrictEqual([
      { source_text: 'a', imported_names: [], ...base },
      { source_text: 'b', imported_names: ['c', '_e'], ...base },
      { source_text: 'k', imported_names: ['l'], ...base },
      { source_text: 'q', imported_names: [], alias: 'Q', ...base },
    ]);
    const node = file.nodes.find((n) => n.id === imp('$root', 0));
    expect([node?.tier, node?.revision_id, node?.file, node?.nameRange]).toEqual([
      'structural',
      'cd'.repeat(32),
      'main.py',
      undefined,
    ]);
  });

  it('gives one import ref site per bound name, at the imported token, not the alias (I20)', async () => {
    const file = await extractOk(FIXTURE);
    expect(importSites(file)).toStrictEqual([
      site(imp('$root', 0), 0, [0, 7], ['a'], whole('a', 'a')),
      site(imp('$root', 1), 0, [1, 14], ['c'], from('b', 'c', 'd')),
      site(imp('$root', 1), 1, [1, 22], ['_e'], from('b', '_e')),
      site(imp('$root', 2), 0, [3, 11], ['f'], whole('f', 'f')),
      site(imp('$root', 3), 0, [5, 22], ['h'], from('g', 'h')),
      site(imp('K.m', 0), 0, [7, 15], ['i'], whole('i', 'i')),
      site(imp('fn', 0), 0, [10, 11], ['j'], whole('j', 'j')),
      site(imp('fn', 1), 0, [12, 22], ['l'], from('k', 'l')),
      site(imp('$root', 4), 0, [17, 11], ['p'], whole('p', 'p')),
      site(imp('$root', 5), 0, [20, 7], ['q'], whole('q', 'Q')),
    ]);
    const ids = file.refSites.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rung 06: the site is `helper` in module util, and the imported call gets no CALLS (I11)', async () => {
    const file = await extractOk(
      lines('from util import helper', '', '', 'def main():', '    helper()'),
    );
    expect(importSites(file)).toStrictEqual([
      site(imp('$root', 0), 0, [0, 17], ['helper'], from('util', 'helper')),
    ]);
    expect(file.edges.filter((e) => e.type === 'CALLS')).toEqual([]);
    expect(file.refSites.filter((s) => s.kind === 'call').map((s) => s.nodeId)).toEqual([
      id('CALL:main:0'),
    ]);
  });

  it('keeps every IMPORT id when an unrelated statement is inserted above; an import above renumbers', async () => {
    const want = { a: imp('fn', 0), b: imp('fn', 1) };
    expect(await byModule('    import a', '    import b')).toEqual(want);
    expect(await byModule('    x = 1', '    import a', '    import b')).toEqual(want);
    expect(await byModule('    import z', '    import a', '    import b')).toEqual({
      z: imp('fn', 0),
      a: imp('fn', 1),
      b: imp('fn', 2),
    });
  });

  // r2 (review 2-5): a nested class's import is its own, a repeated METHOD continues its scope's count
  // (as its CALLs do, pass-b.ts), and a class or an ERROR inside a METHOD body is not walked.
  it('DECLARES from the nearest class; a repeated METHOD continues its count; a body class or ERROR is skipped', async () => {
    const file = await extractOk(NESTED);
    expect(nodesOf(file, 'IMPORT')).toEqual([
      `${imp('$root', 0)} 3:8-3:16`,
      `${imp('$root', 1)} 4:4-4:12`,
      `${imp('P.v', 0)} 8:8-8:16`,
      `${imp('P.v', 1)} 11:8-11:16`,
      `${imp('fn', 0)} 17:4-17:13`,
    ]);
    const declares = file.edges.filter((e) => e.type === 'DECLARES' && e.to.label === 'IMPORT');
    expect(declares.map((e) => `${e.from.key} -> ${e.to.key}`)).toEqual([
      `${id('TYPE_DECL:Outer.Inner')} -> ${imp('$root', 0)}`,
      `${id('TYPE_DECL:Outer')} -> ${imp('$root', 1)}`,
      `${id('METHOD:P.v')} -> ${imp('P.v', 0)}`,
      `${id('METHOD:P.v:1')} -> ${imp('P.v', 1)}`,
      `${id('METHOD:fn')} -> ${imp('fn', 0)}`,
    ]);
    expect(importSites(file).map((s) => s.importBinding?.module)).toEqual([
      'x',
      'y',
      'a',
      'b',
      'ok',
    ]);
  });

  it('does not walk an import inside an ERROR, which takes no ordinal (decision 95)', async () => {
    const file = await extractOk(lines('from m import a, *', 'import ok'));
    expect(nodesOf(file, 'UNKNOWN')).toEqual([`${id('UNKNOWN:$root:0')} 1:0-1:18`]);
    expect(nodesOf(file, 'IMPORT')).toEqual([`${imp('$root', 0)} 2:0-2:9`]);
    expect(importSites(file).map((s) => s.importBinding?.module)).toEqual(['ok']);
  });

  it('a truncated file has no IMPORT, no import site and no re-export (I21)', async () => {
    const outcome = await extractPy(lines('import a', 'import b'), { maxNodes: 2 });
    if (outcome.kind !== 'truncated') throw new Error(`expected truncated, got ${outcome.kind}`);
    expect([nodesOf(outcome.file, 'IMPORT'), outcome.file.refSites]).toEqual([[], []]);
    expect(outcome.file.interfaceHash).toBe(
      'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });
});

describe('interfaceHash re-exports: module-level exported bindings (decision 94, BMO-134)', () => {
  it('matches the oracle: a, d (b:c), p and Q join; _e, class- and function-level imports do not', async () => {
    // sha256 of [["Q","reexport","q"],["a","reexport","a"],["d","reexport","b:c"],
    // ["file:main.py:METHOD:K.m","method","m(self)"],["file:main.py:METHOD:fn","function","fn()"],
    // ["file:main.py:TYPE_DECL:K","class",null],["p","reexport","p"]], computed outside cpg.
    const file = await extractOk(FIXTURE);
    expect(file.interfaceHash).toBe(
      'sha256:263c243493e84518edaf5534375019ed85e0bfa35fae699c20d1b5934258161e',
    );
  });

  it('changes with a module-level name or its source, and not with order, privacy or nesting', async () => {
    const base = await hash('from .core import Engine', 'import os');
    const same = await Promise.all([
      hash('import os', 'from .core import Engine'),
      hash('from .core import Engine', 'import os', 'import _hidden', 'from m import x as _y'),
    ]);
    const differ = await Promise.all([
      hash('from .engine import Engine', 'import os'),
      hash('from ..core import Engine', 'import os'),
      hash('from .core import Engine as Motor', 'import os'),
      hash('from .core import Engine', 'import os as system'),
      hash('from .core import Engine', 'import os', 'from m import *'),
      hash('from .core import Engine'),
    ]);
    expect([same.map((h) => h === base), differ.map((h) => h === base)]).toEqual([
      [true, true],
      [false, false, false, false, false, false],
    ]);
    const nested = await Promise.all([
      hash('class K:', '    pass', 'def f():', '    pass'),
      hash('class K:', '    import json', 'def f():', '    import sys'),
    ]);
    expect(nested[1]).toBe(nested[0]);
  });
});
