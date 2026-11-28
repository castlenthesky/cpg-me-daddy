// Every Python file in fixtures/ladder, and in extract's own fixtures (test/fixtures/pass-a and
// test/fixtures/pass-b, in the ladder's format), parsed by the real wasm grammar and extracted. The
// expected lines were written by hand from the source (ladder README), so this checks extract against an
// answer it did not produce:
// - precision: everything extract emits is a fact of its rung, with the listed properties; a SYMBOL is
//   a DEFINES target or a CALLS target (a builtin's, I11);
// - recall at the Pass A tier (U6a.2-3): every MODULE, TYPE_DECL, METHOD, PARAM, MEMBER and UNKNOWN
//   line of a .py file and every DECLARES, HAS_PARAM and DEFINES between them is emitted;
// - recall at the Pass B tier (U6a.2-4a): every CALL, IN_SCOPE and REACHING_DEF line, and every CALLS
//   line extract can know (I11: from a CALL with no receiver, to this file's SYMBOL or a builtin);
// - recall of Pass B's imports (BMO-134): every IMPORT line and every DECLARES to one, the node half of
//   rungs 06 and 07 (their IMPORTS lines are the resolver's, U6c);
// - the whole code tier of rung 01, rung 04 and both fixtures (SOURCE_FILE is the engine's, C-EXTRACT Q8);
// - coverage is honest both ways (I14): the rows marked `emits` are exactly what the corpus shows.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { formatRange, isWorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExtractedFile, ExtractOutcome, PropertyValue } from './contract';
import { createExtractor } from './extractor';
import { pythonAdapter } from './python';

const LADDER = join(__dirname, '../../../fixtures/ladder');
const FIXTURES = join(__dirname, '../test/fixtures');
/** Extract's own fixtures, named like rungs. */
const OWN = new Set(['pass-a', 'pass-b']);
/** A rung's directory: a ladder rung, or one of extract's own fixtures. */
const dirOf = (rung: string): string => (OWN.has(rung) ? join(FIXTURES, rung) : join(LADDER, rung));
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

/** One fact line: a node (`LABEL id k=v`) or an edge (`TYPE from -> to k=v`). */
interface Fact {
  readonly head: string;
  readonly key: string;
  readonly props: ReadonlyMap<string, string>;
}

const CODE_SECTIONS = new Set(['structural', 'symbols', 'resolution']);

/** The code-tier facts of one rung: [structural], [symbols] and [resolution]. */
function factsOf(rung: string): Fact[] {
  const facts: Fact[] = [];
  let section = '';
  for (const raw of readFileSync(join(dirOf(rung), 'expected.cpg'), 'utf8').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) section = header[1] ?? '';
    if (header || line === '' || !CODE_SECTIONS.has(section)) continue;
    const words = line.split(/\s+/);
    const isEdge = words[2] === '->';
    const rest = words.slice(isEdge ? 4 : 2).map((kv) => {
      const [name = '', ...value] = kv.split('=');
      return [name, value.join('=')] as const;
    });
    const key = isEdge ? `${words[1]} -> ${words[3]}` : (words[1] ?? '');
    facts.push({ head: words[0] ?? '', key, props: new Map(rest) });
  }
  return facts;
}

const text = (value: PropertyValue): string =>
  Array.isArray(value) ? `[${value.join(',')}]` : String(value);

/** What extract emitted, as facts: nodes with file and range, edges, and each SYMBOL as a DEFINES target. */
function emitted(file: ExtractedFile): { facts: Fact[]; symbols: string[] } {
  const facts: Fact[] = [];
  for (const n of file.nodes) {
    const props = new Map(Object.entries(n.properties).map(([k, v]) => [k, text(v)]));
    props.set('file', n.file).set('range', formatRange(n.range));
    if (n.nameRange !== undefined) props.set('name_range', formatRange(n.nameRange));
    facts.push({ head: n.label, key: n.id, props });
  }
  for (const e of file.edges) {
    const props = new Map(Object.entries(e.properties).map(([k, v]) => [k, text(v)]));
    facts.push({ head: e.type, key: `${e.from.key} -> ${e.to.key}`, props });
  }
  return { facts, symbols: file.symbols.map((s) => s.fqn) };
}

/**
 * `want` holds a fact with `got`'s head and key, and `got` agrees on every property `want` lists
 * (`null` is the absent value, ladder README).
 */
function holds(want: readonly Fact[], got: Fact): boolean {
  return want.some(
    (w) =>
      w.head === got.head &&
      w.key === got.key &&
      [...w.props].every(([k, v]) => (v === 'null' ? !got.props.has(k) : got.props.get(k) === v)),
  );
}

interface Extracted {
  readonly rung: string;
  readonly path: string;
  readonly outcome: ExtractOutcome;
  readonly again: ExtractOutcome;
}

function pythonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return pythonFiles(full);
    return entry.name.endsWith('.py') ? [full] : [];
  });
}

const RUNGS = [...readdirSync(LADDER).filter((rung) => /^\d\d-/.test(rung)), ...OWN];
const extracted: Extracted[] = [];

/** Parses `text` and extracts it, releasing the tree whatever happens. */
async function parseAndExtract(path: string, source: string): Promise<ExtractOutcome> {
  if (!isWorkspacePath(path)) throw new Error(`${path} is not a workspace path`);
  const parsed = await service.parse({ key: path, text: source });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    return createExtractor().extract({
      path,
      grammarId: parsed.handle.language,
      root: parsed.handle.root,
      revision_id: createHash('sha256').update(source).digest('hex'),
      lineCount: source.split('\n').length,
    });
  } finally {
    parsed.handle.release();
  }
}

beforeAll(async () => {
  for (const rung of RUNGS) {
    const ws = join(dirOf(rung), 'ws');
    for (const full of pythonFiles(ws)) {
      const path = relative(ws, full);
      const source = readFileSync(full, 'utf8');
      const outcome = await parseAndExtract(path, source);
      const again = await parseAndExtract(path, source);
      extracted.push({ rung, path, outcome, again });
    }
  }
});

const PASS_A_LABELS = new Set(['MODULE', 'TYPE_DECL', 'METHOD', 'PARAM', 'MEMBER', 'UNKNOWN']);
const PASS_A_EDGES = new Set(['DECLARES', 'HAS_PARAM', 'DEFINES']);

/** A Pass A line of a .py file: a declaration node, or an edge between declarations (no IMPORT). */
const passATier = (w: Fact) =>
  /^file:[^ ]*\.py:/.test(w.key) &&
  (PASS_A_LABELS.has(w.head) || (PASS_A_EDGES.has(w.head) && !w.key.includes(':IMPORT:')));

/** A Pass B import line of a .py file (BMO-134): an IMPORT, or a DECLARES to one. */
const importTier = (w: Fact) =>
  /^file:[^ ]*\.py:/.test(w.key) &&
  (w.head === 'IMPORT' || (w.head === 'DECLARES' && w.key.includes(':IMPORT:')));

const PASS_B_EDGES = new Set(['IN_SCOPE', 'REACHING_DEF']);
/** A local SYMBOL fqn's file (`` `main.py`/helper(). `` -> `main.py`); undefined for an external one. */
const fqnFile = (fqn: string): string | undefined => /^`((?:[^`]|``)*)`\//.exec(fqn)?.[1];
/** A file-owned id's file (`file:main.py:CALL:main:0` -> `main.py`). */
const idFile = (id: string): string => /^file:([^:]*):/.exec(id)?.[1] ?? '';

/**
 * A Pass B line of a .py file (U6a.2-4a): a CALL, an IN_SCOPE or REACHING_DEF edge, or a CALLS line
 * extract can know (I11): its CALL, listed in the same rung, has no receiver_text, and its target is
 * this file's SYMBOL or an external one. Rung 06/07's cross-file CALLS and rung 08's receiver call are
 * the resolvers' (U6c, U8).
 */
function passBTier(w: Fact, rungFacts: readonly Fact[]): boolean {
  if (!/^file:[^ ]*\.py:/.test(w.key)) return false;
  if (w.head === 'CALL' || PASS_B_EDGES.has(w.head)) return true;
  if (w.head !== 'CALLS') return false;
  const [from = '', to = ''] = w.key.split(' -> ');
  const call = rungFacts.find((f) => f.head === 'CALL' && f.key === from);
  const receiver = call?.props.get('receiver_text');
  if (call === undefined || (receiver !== undefined && receiver !== 'null')) return false;
  const target = fqnFile(to);
  return target === undefined || target === idFile(from);
}

/** A rung's DEFINES and CALLS targets: every SYMBOL extract may mint for it. */
const symbolTargets = (want: readonly Fact[]): Set<string> =>
  new Set(
    want
      .filter((w) => w.head === 'DEFINES' || w.head === 'CALLS')
      .map((w) => w.key.split(' -> ')[1] ?? ''),
  );

const files = () =>
  extracted.flatMap((e) => (e.outcome.kind === 'ok' ? [{ ...e, file: e.outcome.file }] : []));

/** What extract emitted for one rung's files. Round two: recall is per rung, so one rung's main.py
 * cannot stand in for another's. */
const ofRung = (rung: string): Fact[] =>
  files()
    .filter((f) => f.rung === rung)
    .flatMap(({ file }) => emitted(file).facts);

describe('fixtures/ladder through the real grammar and extract', () => {
  it('extracts every Python file of rungs 01-09 and both fixtures ok, syntax errors included', () => {
    expect(extracted.map((e) => `${e.rung}/${e.path} ${e.outcome.kind}`)).toEqual(
      expect.arrayContaining([
        '01-empty-module/main.py ok',
        '04-local-call/main.py ok',
        '09-syntax-error/main.py ok',
        'pass-a/broken.py ok',
        'pass-a/decl.py ok',
        'pass-b/calls.py ok',
      ]),
    );
    expect(extracted.length).toBe(15);
    expect(extracted.filter((e) => e.outcome.kind !== 'ok')).toEqual([]);
  });

  it('emits nothing its rung does not hold (precision)', () => {
    const problems = files().flatMap(({ rung, path, file }) => {
      const want = factsOf(rung);
      const { facts, symbols } = emitted(file);
      const targets = symbolTargets(want);
      return [
        ...facts.filter((f) => !holds(want, f)).map((f) => `${rung}/${path}: ${f.head} ${f.key}`),
        ...symbols.filter((s) => !targets.has(s)).map((s) => `${rung}/${path}: SYMBOL ${s}`),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('emits every Pass A line of a .py file, with its listed properties (recall at this tier)', () => {
    const wanted = RUNGS.flatMap((rung) =>
      factsOf(rung)
        .filter(passATier)
        .map((w) => ({ rung, w })),
    );
    const missing = wanted.filter(({ rung, w }) => !ofRung(rung).some((g) => holds([w], g)));
    expect(missing.map(({ rung, w }) => `${rung}: ${w.head} ${w.key}`)).toEqual([]);
    // Counted in the expected files: rungs 01-09 hold 2+5+9+8+15+10+14+13+5, the Pass A fixture 82,
    // the Pass B fixture 48 (19 nodes, 10 DECLARES, 8 HAS_PARAM, 11 DEFINES).
    expect(wanted.filter(({ rung }) => !OWN.has(rung)).length).toBe(81);
    expect(wanted.filter(({ rung }) => rung === 'pass-a').length).toBe(82);
    expect(wanted.length).toBe(211);
  });

  it('emits every Pass B line of a .py file it can know, with its listed properties (U6a.2-4a)', () => {
    const wanted = RUNGS.flatMap((rung) => {
      const all = factsOf(rung);
      return all.filter((w) => passBTier(w, all)).map((w) => ({ rung, w }));
    });
    const missing = wanted.filter(({ rung, w }) => !ofRung(rung).some((g) => holds([w], g)));
    expect(missing.map(({ rung, w }) => `${rung}: ${w.head} ${w.key}`)).toEqual([]);
    // Counted in the expected files: rungs 04, 06, 07, 08 hold 6 CALL + 6 IN_SCOPE + 3 CALLS (04's
    // two, 08's constructor); the Pass A fixture 4 + 4 + 1 (property); the Pass B fixture 14 CALL,
    // 14 IN_SCOPE, 9 REACHING_DEF, 12 CALLS.
    const count = (pick: (rung: string) => boolean) =>
      wanted.filter(({ rung }) => pick(rung)).length;
    expect([
      count((r) => !OWN.has(r)),
      count((r) => r === 'pass-a'),
      count((r) => r === 'pass-b'),
    ]).toEqual([15, 9, 49]);
  });

  it('emits every IMPORT line of a .py file and its DECLARES, with its listed properties (BMO-134)', () => {
    const wanted = RUNGS.flatMap((rung) =>
      factsOf(rung)
        .filter(importTier)
        .map((w) => ({ rung, w })),
    );
    const missing = wanted.filter(({ rung, w }) => !ofRung(rung).some((g) => holds([w], g)));
    expect(missing.map(({ rung, w }) => `${rung}: ${w.head} ${w.key}`)).toEqual([]);
    // Counted in the expected files: rungs 06 and 07 hold one IMPORT and its DECLARES each.
    // r2 (review 1): compared sorted, whatever order the directory listing gives.
    expect(wanted.map(({ rung, w }) => `${rung} ${w.head}`).toSorted()).toEqual([
      '06-import DECLARES',
      '06-import IMPORT',
      '07-package DECLARES',
      '07-package IMPORT',
    ]);
  });

  it.each([
    ['pass-a', ['broken.py', 'decl.py']],
    ['pass-b', ['calls.py']],
    ['04-local-call', ['main.py']],
  ])("is %s's whole code tier, SOURCE_FILE aside, each SYMBOL once", (rung, paths) => {
    const fixture = files().filter((f) => f.rung === rung);
    expect(fixture.map((f) => f.path).toSorted()).toEqual(paths);
    const want = factsOf(rung).filter((w) => w.head !== 'SOURCE_FILE');
    const got = fixture.flatMap(({ file }) => emitted(file).facts);
    expect(got.map((f) => `${f.head} ${f.key}`).toSorted()).toEqual(
      want.map((w) => `${w.head} ${w.key}`).toSorted(),
    );
    expect(want.filter((w) => !got.some((g) => holds([w], g)))).toEqual([]);
    // Each SYMBOL once (I7): no fixture here has two files minting the same fqn.
    expect(fixture.flatMap(({ file }) => emitted(file).symbols).toSorted()).toEqual(
      [...symbolTargets(want)].toSorted(),
    );
  });

  it("is rung 01's whole code tier, SOURCE_FILE aside", () => {
    const rung01 = files().find((f) => f.rung === '01-empty-module');
    if (rung01 === undefined) throw new Error('rung 01 was not extracted');
    const want = factsOf('01-empty-module').filter((w) => w.head !== 'SOURCE_FILE');
    const { facts, symbols } = emitted(rung01.file);
    expect(facts.map((f) => `${f.head} ${f.key}`).toSorted()).toEqual(
      want.map((w) => `${w.head} ${w.key}`).toSorted(),
    );
    expect(want.filter((w) => !facts.some((g) => holds([w], g)))).toEqual([]);
    expect(symbols).toEqual(['`main.py`/']);
  });

  it('marks emits exactly the labels and edge types the corpus shows (I14 both ways)', () => {
    const manifest = pythonAdapter.coverage();
    const shown = new Set(
      files().flatMap(({ file }) => [
        ...file.nodes.map((n) => n.label),
        ...(file.symbols.length > 0 ? ['SYMBOL'] : []),
        ...file.edges.map((e) => e.type),
      ]),
    );
    const marked = [...Object.entries(manifest.nodes), ...Object.entries(manifest.edges)]
      .filter(([, d]) => d.state === 'emits')
      .map(([key]) => key);
    expect([...shown].toSorted()).toEqual(marked.toSorted());
  });

  it('counts columns in UTF-16 code units on a real tree (I23, r2)', async () => {
    // Line 2 is `x = "` (5), two emoji (2 code units each, 4 UTF-8 bytes each), `"` (1): column 10.
    const outcome = await parseAndExtract('emoji.py', 'y = 1\nx = "\u{1F600}\u{1F600}"');
    if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`);
    expect(outcome.file.nodes[0]?.range).toEqual({
      startRow: 0,
      startColumn: 0,
      endRow: 1,
      endColumn: 10,
    });
  });

  it('is deterministic over real trees: a second parse gives byte-identical output (I3)', () => {
    const differ = extracted.filter((e) => JSON.stringify(e.again) !== JSON.stringify(e.outcome));
    expect(differ.map((e) => `${e.rung}/${e.path}`)).toEqual([]);
  });
});
