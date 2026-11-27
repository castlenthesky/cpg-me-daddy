// Every Python file in fixtures/ladder, parsed by the real wasm grammar and extracted. The expected
// lines were written by hand from the source (ladder README), so this checks extract against an
// answer it did not produce:
// - precision: everything extract emits is a fact of its rung, with the listed properties;
// - recall at this tier: every MODULE line and every DEFINES from a MODULE is emitted, and rung 01's
//   whole code tier (SOURCE_FILE is the engine's, C-EXTRACT Q8);
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
  for (const raw of readFileSync(join(LADDER, rung, 'expected.cpg'), 'utf8').split('\n')) {
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
    facts.push({ head: n.label, key: n.id, props });
  }
  for (const e of file.edges) {
    const props = new Map(Object.entries(e.properties).map(([k, v]) => [k, text(v)]));
    facts.push({ head: e.type, key: `${e.from.key} -> ${e.to.key}`, props });
  }
  return { facts, symbols: file.symbols.map((s) => s.fqn) };
}

/** `want` holds a fact with `got`'s head and key, and `got` agrees on every property `want` lists. */
function holds(want: readonly Fact[], got: Fact): boolean {
  return want.some(
    (w) =>
      w.head === got.head &&
      w.key === got.key &&
      [...w.props].every(([k, v]) => got.props.get(k) === v),
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

const RUNGS = readdirSync(LADDER).filter((rung) => /^\d\d-/.test(rung));
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
    const ws = join(LADDER, rung, 'ws');
    for (const full of pythonFiles(ws)) {
      const path = relative(ws, full);
      const source = readFileSync(full, 'utf8');
      const outcome = await parseAndExtract(path, source);
      const again = await parseAndExtract(path, source);
      extracted.push({ rung, path, outcome, again });
    }
  }
});

/** A MODULE line of a .py file, or a DEFINES from one. */
const moduleTier = (w: Fact) =>
  /^file:[^ ]*\.py:MODULE:/.test(w.key) && (w.head === 'MODULE' || w.head === 'DEFINES');

const files = () =>
  extracted.flatMap((e) => (e.outcome.kind === 'ok' ? [{ ...e, file: e.outcome.file }] : []));

describe('fixtures/ladder through the real grammar and extract', () => {
  it('extracts every Python file of rungs 01-09 ok, the syntax error included', () => {
    expect(extracted.map((e) => `${e.rung}/${e.path} ${e.outcome.kind}`)).toEqual(
      expect.arrayContaining(['01-empty-module/main.py ok', '09-syntax-error/main.py ok']),
    );
    expect(extracted.length).toBe(12);
    expect(extracted.filter((e) => e.outcome.kind !== 'ok')).toEqual([]);
  });

  it('emits nothing its rung does not hold (precision)', () => {
    const problems = files().flatMap(({ rung, path, file }) => {
      const want = factsOf(rung);
      const { facts, symbols } = emitted(file);
      const targets = new Set(
        want.filter((w) => w.head === 'DEFINES').map((w) => w.key.split(' -> ')[1]),
      );
      return [
        ...facts.filter((f) => !holds(want, f)).map((f) => `${rung}/${path}: ${f.head} ${f.key}`),
        ...symbols.filter((s) => !targets.has(s)).map((s) => `${rung}/${path}: SYMBOL ${s}`),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('emits every MODULE line and every DEFINES from a MODULE of a .py file (recall at this tier)', () => {
    const all = files().flatMap(({ file }) => emitted(file).facts);
    const wanted = RUNGS.flatMap((rung) =>
      factsOf(rung)
        .filter(moduleTier)
        .map((w) => ({ rung, w })),
    );
    const missing = wanted.filter(({ w }) => !all.some((g) => holds([w], g)));
    expect(missing.map(({ rung, w }) => `${rung}: ${w.head} ${w.key}`)).toEqual([]);
    // 12 .py files in rungs 01-09: one MODULE line and one DEFINES from it each.
    expect(wanted.length).toBe(24);
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

  it('is deterministic over real trees: a second parse gives byte-identical output (I3)', () => {
    const differ = extracted.filter((e) => JSON.stringify(e.again) !== JSON.stringify(e.outcome));
    expect(differ.map((e) => `${e.rung}/${e.path}`)).toEqual([]);
  });
});
