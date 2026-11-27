// The code tier's parts (U6a.3-2; controller decisions 96, 100, 101; C-PARSE I19; C-EXTRACT Q8).
// Expected values are written from the decisions, code-tier.ts's docs, the ladder's range form
// (fixtures/ladder/README.md: 1-based lines, 0-based UTF-16 columns, exclusive end) and the archive
// rules the file ports (source-file.ts, index-workspace.ts:204), never from running the code.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtractedFile, ExtractOutcome, ExtractRequest, Extractor } from '@cpg/extract';
import { createExtractor } from '@cpg/extract';
import type { WorkspacePath } from '@cpg/model';
import { formatRange, isWorkspacePath } from '@cpg/model';
import type {
  GrammarDirOutcome,
  ParseHandle,
  ParseOutcome,
  ParseRequest,
  ParseService,
  ParseServiceOptions,
} from '@cpg/parse';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import type { EdgeRow, NodeRow } from '@cpg/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeTier, CodeTierFailure, CodeTierOptions, ReplaceFileOp } from './code-tier';
import {
  failureWarnings,
  attachSourceFile,
  createCodeTier,
  createDiskGrammarSource,
  decodeSource,
  lineCountOf,
} from './code-tier';
import type { WalkedFile } from './walker/walker';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cpg-code-tier-'));
  roots.push(dir);
  return dir;
}

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const BOM = [0xef, 0xbb, 0xbf];
const withBom = (s: string): Uint8Array => Uint8Array.from([...BOM, ...utf8(s)]);

const GRAMMAR_PKG = BUILTIN_LANGUAGES.find((l) => l.id === 'python')?.grammar;
const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');

function registry() {
  const r = createLanguageRegistry();
  for (const lang of BUILTIN_LANGUAGES) r.register(lang);
  r.freeze();
  return r;
}

function walked(path: string, bytes: Uint8Array): WalkedFile & { readonly language: string } {
  const p = wp(path);
  const at = path.lastIndexOf('/');
  return {
    path: p,
    parent: wp(at === -1 ? '.' : path.slice(0, at)),
    language: 'python',
    sizeBytes: bytes.byteLength,
    revision_id: sha256(bytes),
  };
}

// ── decodeSource and lineCountOf ──

describe('decodeSource (decision 100: TextDecoder utf-8)', () => {
  it.each([
    ['empty', [], ''],
    ['a leading BOM is stripped', [...BOM, 0x78], 'x'],
    ['a BOM after the first byte is kept', [0x61, ...BOM], 'a﻿'],
    ['an invalid byte is U+FFFD', [0x61, 0xff, 0x62], 'a�b'],
    ['a truncated sequence is U+FFFD', [0x61, 0xc3], 'a�'],
    ['two-byte and astral characters decode', [...utf8('é😀')], 'é😀'],
  ] as const)('%s', (_name, bytes, text) => {
    expect(decodeSource(Uint8Array.from(bytes))).toBe(text);
  });
});

describe('lineCountOf (archive index-workspace.ts:204)', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['\n', 2],
    ['a\n', 2],
    ['a\nb', 2],
    ['a\r\nb\r\n', 3],
    ['def greet():\n    pass\n', 3],
  ] as const)('%j has %i lines', (text, lines) => {
    expect(lineCountOf(text)).toBe(lines);
  });
});

// ── createDiskGrammarSource ──

describe('createDiskGrammarSource (decision 100)', () => {
  const REF = { packageName: '@x/grammars', wasmFile: 'g.wasm' };

  it('reads the located file: its bytes, with the path as origin', async () => {
    const dir = await tmp();
    const bytes = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01]);
    await writeFile(join(dir, 'g.wasm'), bytes);
    const asked: string[] = [];
    const source = createDiskGrammarSource((pkg) => {
      asked.push(pkg);
      return { ok: true, dir, via: 'explicit' };
    });
    const got = await source.load(REF);
    expect(got.ok && [[...got.bytes], got.origin]).toEqual([[...bytes], join(dir, 'g.wasm')]);
    expect(asked).toEqual(['@x/grammars']);
    expect(source.describe()).toBe('node:fs grammar source');
  });

  it('asks the locator on every load, a failed one included (I15: no failure is memoised)', async () => {
    const dir = await tmp();
    let outcome: GrammarDirOutcome = { ok: false, via: 'CPG_GRAMMAR_DIR', message: 'no dir yet' };
    let asks = 0;
    const source = createDiskGrammarSource(() => {
      asks += 1;
      return outcome;
    });
    expect(await source.load(REF)).toEqual({ ok: false, message: 'no dir yet' });
    await writeFile(join(dir, 'g.wasm'), 'w');
    outcome = { ok: true, dir, via: 'CPG_GRAMMAR_DIR' };
    const fixed = await source.load(REF);
    const again = await source.load(REF);
    expect([fixed.ok, again.ok, asks]).toEqual([true, true, 3]);
  });

  it('a missing file is ok:false naming the path, never a throw', async () => {
    const dir = await tmp();
    const source = createDiskGrammarSource(() => ({ ok: true, dir, via: 'package-anchor' }));
    const got = await source.load(REF);
    expect(got.ok).toBe(false);
    expect(!got.ok && got.message).toContain(join(dir, 'g.wasm'));
    // round two (review 11): and the read error itself
    expect(!got.ok && got.message).toMatch(/ENOENT/);
  });
});

// ── attachSourceFile ──

const row = (label: NodeRow['label'], key: string): NodeRow => ({ label, key, properties: {} });
const DEFINES: EdgeRow = {
  type: 'DEFINES',
  fromLabel: 'MODULE',
  fromKey: 'file:pkg/m.py:MODULE:$root',
  toLabel: 'SYMBOL',
  toKey: '`pkg/m.py`/',
  properties: {},
};
const opWith = (nodes: readonly NodeRow[]): ReplaceFileOp => ({
  kind: 'replace-file',
  file: wp('pkg/m.py'),
  seq: 7,
  revision_id: '5d'.repeat(32),
  nodes,
  edges: [DEFINES],
});
const sourceFile = (fromKey: string): EdgeRow => ({
  type: 'SOURCE_FILE',
  fromLabel: 'MODULE',
  fromKey,
  toLabel: 'FILE',
  toKey: 'pkg/m.py',
  properties: {},
});

describe('attachSourceFile (C-EXTRACT Q8; archive source-file.ts)', () => {
  it('appends one SOURCE_FILE row from the MODULE row to the op FILE, after the op edges', () => {
    const op = opWith([
      row('SYMBOL', '`pkg/m.py`/'),
      row('MODULE', 'file:pkg/m.py:MODULE:$root'),
      row('FILE', 'pkg/m.py'),
    ]);
    const before = structuredClone(op);
    const { op: out, attached } = attachSourceFile(op);
    expect(attached).toBe(true);
    expect(out).toStrictEqual({
      ...before,
      edges: [DEFINES, sourceFile('file:pkg/m.py:MODULE:$root')],
    });
    expect(op).toStrictEqual(before);
    expect(out.edges).not.toBe(op.edges);
  });

  it('takes the first MODULE row when there are two', () => {
    const op = opWith([row('MODULE', 'file:pkg/m.py:MODULE:one'), row('MODULE', 'file:x:two')]);
    expect(attachSourceFile(op).op.edges.at(-1)).toEqual(sourceFile('file:pkg/m.py:MODULE:one'));
  });

  it('no MODULE row: the same op, attached false', () => {
    const op = opWith([row('SYMBOL', '`pkg/m.py`/'), row('FILE', 'pkg/m.py')]);
    const out = attachSourceFile(op);
    expect([out.op, out.attached]).toEqual([op, false]);
    expect(out.op).toBe(op);
  });
});

// ── createCodeTier with stand-ins ──

/** A ParseService stand-in: parse answers `answer(request)`; everything else is unused here. */
const unused = (): never => {
  throw new Error('unused in the code tier');
};
function fakeService(answer: (request: ParseRequest) => Promise<ParseOutcome>): ParseService {
  return {
    ensureReady: unused,
    parse: answer,
    retain: unused,
    releaseDocument: unused,
    provenance: unused,
    stats: unused,
    dispose: unused,
  };
}

interface FakeHandle {
  readonly handle: ParseHandle;
  readonly root: ParseHandle['root'];
  released: number;
}
function fakeHandle(key: string): FakeHandle {
  const root: ParseHandle['root'] = {
    type: 'module',
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 1 },
    startIndex: 0,
    endIndex: 1,
    namedChildren: [],
    childForFieldName: () => null,
    text: 'a',
  };
  const state: FakeHandle = {
    root,
    released: 0,
    handle: {
      key: wp(key),
      language: 'python',
      get root() {
        if (state.released > 0) throw new Error('root after release');
        return root;
      },
      rootType: 'module',
      hasError: false,
      rootTypeMismatch: false,
      get released() {
        return state.released > 0;
      },
      diagnostics: () => ({ errorNodeCount: 0, missingNodeCount: 0, errorSpanRatio: 0 }),
      release() {
        state.released += 1;
      },
    },
  };
  return state;
}

const EXTRACTED = (path: string): ExtractedFile => ({
  path: wp(path),
  grammarId: 'python',
  revision_id: '5d'.repeat(32),
  nodes: [],
  symbols: [],
  edges: [],
  refSites: [],
  stats: { astNodesVisited: 1, structuralNodes: 0, expressionNodes: 0, lineCount: 1 },
  elementDigest: 'd',
  interfaceHash: 'h',
});

function fakeExtractor(
  answer: (request: ExtractRequest) => ExtractOutcome,
  grammars: readonly string[] = ['python'],
): Extractor {
  return {
    contractVersion: 'test',
    grammars,
    coverage: () => {
      throw new Error('unused');
    },
    extract: answer,
  };
}

interface Rig {
  readonly tier: CodeTier;
  readonly created: ParseServiceOptions[];
  readonly parses: ParseRequest[];
  readonly extracts: ExtractRequest[];
  readonly handles: FakeHandle[];
  /** Per extract: was its handle released when extract ran? */
  readonly releasedAtExtract: boolean[];
}

function rig(
  o: {
    readonly parse?: (request: ParseRequest) => ParseOutcome;
    readonly extract?: (request: ExtractRequest) => ExtractOutcome;
    readonly grammars?: readonly string[];
    readonly registry?: CodeTierOptions['registry'];
    readonly runtimeDir?: string;
  } = {},
): Rig {
  const created: ParseServiceOptions[] = [];
  const parses: ParseRequest[] = [];
  const extracts: ExtractRequest[] = [];
  const handles: FakeHandle[] = [];
  const releasedAtExtract: boolean[] = [];
  const tier = createCodeTier({
    registry: o.registry ?? registry(),
    extractor: fakeExtractor((request) => {
      extracts.push(request);
      releasedAtExtract.push(handles.at(-1)?.handle.released ?? true);
      return o.extract?.(request) ?? { kind: 'ok', file: EXTRACTED(request.path) };
    }, o.grammars),
    createParseService: (options) => {
      created.push(options);
      return fakeService(async (request) => {
        parses.push(request);
        if (o.parse !== undefined) return o.parse(request);
        const h = fakeHandle(request.key);
        handles.push(h);
        return { ok: true, handle: h.handle };
      });
    },
    ...(o.runtimeDir !== undefined && { runtimeDir: o.runtimeDir }),
  });
  return { tier, created, parses, extracts, handles, releasedAtExtract };
}

describe('createCodeTier (decisions 96, 100)', () => {
  it('covers exactly the extractor grammars', () => {
    const python = rig();
    const ts = rig({ grammars: ['typescript'] });
    expect(
      ['python', 'typescript', 'tsx', 'javascript', null].map((l) => python.tier.covers(l)),
    ).toEqual([true, false, false, false, false]);
    expect([ts.tier.covers('typescript'), ts.tier.covers('python')]).toEqual([true, false]);
  });

  it('builds ONE ParseService, on the first run, from the frozen registry', async () => {
    const frozen = registry();
    const r = rig({ registry: frozen });
    expect(r.created).toHaveLength(0);
    await r.tier.run(walked('a.py', utf8('a')), utf8('a'));
    await r.tier.run(walked('b.py', utf8('b')), utf8('b'));
    expect(r.created).toHaveLength(1);
    expect(r.created[0]?.registry).toBe(frozen);
    expect(r.created[0]?.source.describe()).toBe('node:fs grammar source');
  });

  // Stop-list 192: the folder of web-tree-sitter's own runtime reaches the one ParseService.
  it('hands createParseService the runtimeDir it was given, and no runtimeDir without one', async () => {
    const given = rig({ runtimeDir: '/install/apps/vscode/dist/grammars' });
    const none = rig();
    await given.tier.run(walked('a.py', utf8('a')), utf8('a'));
    await none.tier.run(walked('a.py', utf8('a')), utf8('a'));
    expect([
      given.created.map((options) => options.runtimeDir),
      none.created.map((options) => Object.hasOwn(options, 'runtimeDir')),
    ]).toEqual([['/install/apps/vscode/dist/grammars'], [false]]);
  });

  it('hands PARSE the decoded text, never a path to read (C-PARSE I19), and extract the walk revision', async () => {
    const r = rig();
    const bytes = withBom('é = 1\r\nb = 2\n');
    const file = walked('pkg/m.py', bytes);
    const got = await r.tier.run(file, bytes);
    expect(r.parses).toStrictEqual([
      { key: 'pkg/m.py', text: 'é = 1\r\nb = 2\n', language: 'python' },
    ]);
    expect(r.extracts).toStrictEqual([
      {
        path: 'pkg/m.py',
        grammarId: 'python',
        root: r.handles[0]?.root,
        revision_id: sha256(bytes),
        lineCount: 3,
      },
    ]);
    expect(got).toEqual({ kind: 'extracted', file: EXTRACTED('pkg/m.py') });
  });

  it('extracts while the tree is live and releases it once, before run resolves', async () => {
    const r = rig();
    await r.tier.run(walked('a.py', utf8('a')), utf8('a'));
    await r.tier.run(walked('b.py', utf8('b')), utf8('b'));
    expect(r.releasedAtExtract).toEqual([false, false]);
    expect(r.handles.map((h) => h.released)).toEqual([1, 1]);
  });

  it('a parse failure is failed with its code and message; extract never runs', async () => {
    const r = rig({
      parse: () => ({
        ok: false,
        error: { code: 'grammar-unavailable', message: 'node:fs grammar source: gone' },
      }),
    });
    expect(await r.tier.run(walked('a.py', utf8('a')), utf8('a'))).toEqual({
      kind: 'failed',
      code: 'grammar-unavailable',
      message: 'node:fs grammar source: gone',
    });
    expect(r.extracts).toEqual([]);
  });

  it('an extract failure is failed with its code and message, and the tree is still released', async () => {
    const r = rig({
      extract: (request) => ({
        kind: 'failed',
        error: { code: 'root-type-mismatch', message: 'expected module', path: request.path },
      }),
    });
    expect(await r.tier.run(walked('a.py', utf8('a')), utf8('a'))).toEqual({
      kind: 'failed',
      code: 'root-type-mismatch',
      message: 'expected module',
    });
    expect(r.handles.map((h) => h.released)).toEqual([1]);
  });

  it('a truncated extract is failed truncated, never written as a short file (C-EXTRACT I17)', async () => {
    const r = rig({
      extract: (request) => ({
        kind: 'truncated',
        file: EXTRACTED(request.path),
        truncation: {
          limit: 'maxNodes',
          limitValue: 9,
          droppedAtNodeType: 'block',
          droppedRange: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 },
        },
      }),
    });
    const got = await r.tier.run(walked('a.py', utf8('a')), utf8('a'));
    expect(got.kind === 'failed' && [got.code, got.message.includes('maxNodes')]).toEqual([
      'truncated',
      true,
    ]);
    // round two (review 12): the tree is released on this path too
    expect(r.handles.map((h) => h.released)).toEqual([1]);
  });

  it('a throw from extract or parse is failed internal with its message; run never throws', async () => {
    const extractThrows = rig({
      extract: () => {
        throw new Error('extract blew up');
      },
    });
    const parseThrows = rig({
      parse: () => {
        throw new Error('parse blew up');
      },
    });
    expect(await extractThrows.tier.run(walked('a.py', utf8('a')), utf8('a'))).toEqual({
      kind: 'failed',
      code: 'internal',
      message: 'extract blew up',
    });
    expect(extractThrows.handles.map((h) => h.released)).toEqual([1]);
    expect(await parseThrows.tier.run(walked('a.py', utf8('a')), utf8('a'))).toEqual({
      kind: 'failed',
      code: 'internal',
      message: 'parse blew up',
    });
  });
});

// ── createCodeTier with the real parser and extractor ──

/** A code tier over the real registry, extractor and ParseService, recording every service made. */
function real(grammarDir?: string) {
  const services: ParseService[] = [];
  const tier = createCodeTier({
    registry: registry(),
    extractor: createExtractor(),
    createParseService: (options) => {
      const service = createParseService(options);
      services.push(service);
      return service;
    },
    ...(grammarDir !== undefined && { grammarDir }),
  });
  return { tier, services };
}

async function moduleRange(tier: CodeTier, path: string, bytes: Uint8Array): Promise<string> {
  const got = await tier.run(walked(path, bytes), bytes);
  if (got.kind !== 'extracted') throw new Error(`not extracted: ${JSON.stringify(got)}`);
  const [module, ...rest] = got.file.nodes;
  if (module?.label !== 'MODULE' || rest.length > 0) throw new Error('expected one MODULE');
  return formatRange(module.range);
}

describe('createCodeTier on the real parser (the package anchor when no grammarDir)', () => {
  it('a MODULE spans the decoded text: BOM stripped, UTF-16 columns, U+FFFD for a bad byte', async () => {
    const { tier, services } = real();
    expect(await moduleRange(tier, 'a.py', utf8('x = 1'))).toBe('1:0-1:5');
    expect(await moduleRange(tier, 'b.py', withBom('x = 1'))).toBe('1:0-1:5');
    expect(await moduleRange(tier, 'c.py', utf8('s = "😀"'))).toBe('1:0-1:8');
    expect(await moduleRange(tier, 'd.py', Uint8Array.from([...utf8('s = "'), 0xff, 0x22]))).toBe(
      '1:0-1:7',
    );
    expect(await moduleRange(tier, 'e.py', utf8('def greet():\n    pass\n'))).toBe('1:0-3:0');
    // one service for all five, every tree released (never two live)
    expect([services.length, services[0]?.stats().liveHandles]).toEqual([1, 0]);
  });

  // round two (review 13): the locator gets no environment, so a CPG_GRAMMAR_DIR in the process's own
  // environment changes nothing (only the front door reads it, decision 100)
  it('ignores CPG_GRAMMAR_DIR in the process environment: no grammarDir is the package anchor', async () => {
    vi.stubEnv('CPG_GRAMMAR_DIR', await tmp());
    try {
      const { tier } = real();
      expect(await moduleRange(tier, 'a.py', utf8('x = 1'))).toBe('1:0-1:5');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('an explicit grammarDir holding the grammar is used', async () => {
    const dir = await tmp();
    if (GRAMMAR_PKG === undefined) throw new Error('no python registration');
    await mkdir(dir, { recursive: true });
    await copyFile(join(WASM_DIR, GRAMMAR_PKG.wasmFile), join(dir, GRAMMAR_PKG.wasmFile));
    const { tier, services } = real(dir);
    expect(await moduleRange(tier, 'a.py', utf8('x = 1\n'))).toBe('1:0-2:0');
    expect(services[0]?.provenance().map((p) => p.origin)).toEqual([
      join(dir, GRAMMAR_PKG.wasmFile),
    ]);
  });

  it('a grammarDir without the grammar, or a relative one, is grammar-unavailable, not a throw', async () => {
    const empty = await tmp();
    const missing = await real(empty).tier.run(walked('a.py', utf8('x')), utf8('x'));
    const relative = await real('wasm').tier.run(walked('a.py', utf8('x')), utf8('x'));
    expect(missing.kind === 'failed' && [missing.code, missing.message]).toEqual([
      'grammar-unavailable',
      expect.stringContaining(join(empty, 'tree-sitter-python.wasm')),
    ]);
    expect(relative.kind === 'failed' && [relative.code, relative.message]).toEqual([
      'grammar-unavailable',
      expect.stringContaining('must be an absolute path'),
    ]);
  });
});

// U6a.3-3: one warning text for index() and the watch (decisions 100, 102), said once per group.
const failed = (
  path: string,
  language: string,
  code: string,
  message: string,
): CodeTierFailure => ({
  path: wp(path),
  language,
  code,
  message,
});

describe('failureWarnings (decisions 100, 102)', () => {
  it('one warning per (language, code) group, in first-failure order, naming its first failure', () => {
    const reported = new Set<string>();
    expect(
      failureWarnings(
        [
          failed('a.py', 'python', 'grammar-unavailable', 'm1'),
          failed('b.ts', 'typescript', 'grammar-unavailable', 'm2'),
          failed('c.py', 'python', 'grammar-unavailable', 'm3'),
          failed('d.py', 'python', 'truncated', 'm4'),
          failed('e.py', 'python', 'grammar-unavailable', 'm5'),
          // a key built by joining the two with a comma would merge these two groups
          failed('f', 'a,b', 'c', 'm6'),
          failed('g', 'a', 'b,c', 'm7'),
        ],
        reported,
      ),
    ).toEqual([
      'code tier: 3 python files at the FILE tier only (grammar-unavailable): a.py: m1',
      'code tier: 1 typescript file at the FILE tier only (grammar-unavailable): b.ts: m2',
      'code tier: 1 python file at the FILE tier only (truncated): d.py: m4',
      'code tier: 1 a,b file at the FILE tier only (c): f: m6',
      'code tier: 1 a file at the FILE tier only (b,c): g: m7',
    ]);
    expect(reported.size).toBe(5);
  });

  it('a group already in `reported` is not said again; a new one is, and joins it', () => {
    const reported = new Set<string>();
    failureWarnings([failed('a.py', 'python', 'truncated', 'm1')], reported);
    expect(
      failureWarnings(
        [
          failed('b.py', 'python', 'truncated', 'm2'),
          failed('c.py', 'python', 'read-failed', 'm3'),
          failed('d.py', 'python', 'read-failed', 'm4'),
        ],
        reported,
      ),
    ).toEqual(['code tier: 2 python files at the FILE tier only (read-failed): c.py: m3']);
    expect(failureWarnings([failed('e.py', 'python', 'read-failed', 'm5')], reported)).toEqual([]);
    expect([failureWarnings([], reported), reported.size]).toEqual([[], 2]);
  });
});
