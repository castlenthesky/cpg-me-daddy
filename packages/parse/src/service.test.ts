import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import type { GrammarSource, LanguageRegistration, ParseHandle, ParseService } from './contract';
import { BUILTIN_LANGUAGES, createLanguageRegistry } from './registry';
import { createParseService, HandleReleasedError } from './service';

function wp(path: string): WorkspacePath {
  if (!isWorkspacePath(path)) throw new Error(`not a workspace path: ${path}`);
  return path;
}

const shape = (h: ParseHandle): string =>
  JSON.stringify(h.root, ['type', 'namedChildren', 'startIndex']);

// The host's job in production (a GrammarSource reading @vscode/tree-sitter-wasm); a test double here.
const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
const diskSource = (reads: string[] = []): GrammarSource => ({
  describe: () => `test source ${WASM_DIR}`,
  async load(ref) {
    reads.push(ref.wasmFile);
    try {
      const origin = join(WASM_DIR, ref.wasmFile);
      return { ok: true, bytes: new Uint8Array(await readFile(origin)), origin };
    } catch (cause) {
      return { ok: false, message: String(cause) };
    }
  },
});

function registryOf(languages: readonly LanguageRegistration[] = BUILTIN_LANGUAGES) {
  const registry = createLanguageRegistry();
  for (const r of languages) registry.register(r);
  registry.freeze();
  return registry;
}

let service: ParseService | undefined;
afterEach(() => service?.dispose());
const make = (source: GrammarSource = diskSource(), languages?: readonly LanguageRegistration[]) =>
  (service = createParseService({ registry: registryOf(languages), source }));

async function ok(s: ParseService, key: string, text: string): Promise<ParseHandle> {
  const outcome = await s.parse({ key: wp(key), text });
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.handle;
}

describe('parse', () => {
  it('parses text it is handed, for a key with no file on disk (I19)', async () => {
    const handle = await ok(make(), 'nowhere/never.py', 'def f():\n    pass\n');
    expect([handle.language, handle.rootType, handle.hasError, handle.rootTypeMismatch]).toEqual([
      'python',
      'module',
      false,
      false,
    ]);
    expect(handle.root.namedChildren.map((n) => n.type)).toEqual(['function_definition']);
  });

  it('never truncates node text: a 200-character literal round-trips (I21)', async () => {
    const literal = `"${'x'.repeat(198)}"`;
    const handle = await ok(make(), 'a.py', `s = ${literal}\n`);
    const assignment = handle.root.namedChildren[0]?.namedChildren[0];
    expect(assignment?.childForFieldName('right')?.text).toBe(literal);
  });

  it('a syntax error is a successful parse; a missing token is counted, not spanned (I22)', async () => {
    // Ladder rung 09. tree-sitter recovers with one zero-width MISSING ")" and no ERROR node.
    const handle = await ok(make(), 'main.py', 'def broken(:\n    pass\n');
    expect(handle.hasError).toBe(true);
    expect(handle.diagnostics()).toEqual({
      errorNodeCount: 0,
      missingNodeCount: 1,
      errorSpanRatio: 0,
    });
  });

  it('an ERROR region is counted and spanned', async () => {
    // "x = 1 1 1": the two stray integers ("1 1", 3 of 10 characters) become one ERROR node.
    const handle = await ok(make(), 'a.py', 'x = 1 1 1\n');
    expect(handle.diagnostics()).toEqual({
      errorNodeCount: 1,
      missingNodeCount: 0,
      errorSpanRatio: 0.3,
    });
  });

  it('a clean parse has zero diagnostics, including an empty file', async () => {
    const s = make();
    expect((await ok(s, 'a.py', 'x = 1\n')).diagnostics()).toEqual({
      errorNodeCount: 0,
      missingNodeCount: 0,
      errorSpanRatio: 0,
    });
    expect((await ok(s, 'empty.py', '')).diagnostics().errorSpanRatio).toBe(0);
  });

  it('flags a root type the registration does not expect', async () => {
    const wrong = BUILTIN_LANGUAGES.map((r) =>
      r.id === 'python' ? { ...r, rootNodeType: 'program' } : r,
    );
    expect((await ok(make(diskSource(), wrong), 'a.py', 'x = 1\n')).rootTypeMismatch).toBe(true);
  });

  it('is deterministic: the same text gives the same tree (I33)', async () => {
    const s = make();
    const text = 'class A:\n    def m(self):\n        return 1\n';
    const a = await ok(s, 'a.py', text);
    const b = await ok(s, 'a.py', text);
    expect(shape(a)).toBe(shape(b));
  });

  it('an explicit language overrides routing by extension', async () => {
    const s = make();
    expect((await s.parse({ key: wp('script'), text: 'x = 1\n' })).ok).toBe(false);
    const outcome = await s.parse({ key: wp('script'), text: 'x = 1\n', language: 'python' });
    expect(outcome.ok && outcome.handle.rootType).toBe('module');
  });
});

describe('failures are outcomes, never throws', () => {
  it('an unrouted key or unregistered language is unsupported-language (I6)', async () => {
    const s = make();
    expect(await s.parse({ key: wp('Makefile'), text: 'all:' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported-language', key: 'Makefile' },
    });
    expect(await s.parse({ key: wp('a.rb'), text: '', language: 'ruby' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported-language', language: 'ruby' },
    });
    expect(await s.ensureReady(['python', 'ruby'])).toMatchObject([
      { code: 'unsupported-language', language: 'ruby' },
    ]);
  });

  it('missing bytes are grammar-unavailable, and a fixed cause succeeds next time (I15)', async () => {
    let broken = true;
    const real = diskSource();
    const s = make({
      describe: () => 'flaky',
      load: (ref) => (broken ? Promise.resolve({ ok: false, message: 'gone' }) : real.load(ref)),
    });
    expect(await s.parse({ key: wp('a.py'), text: '' })).toMatchObject({
      ok: false,
      error: { code: 'grammar-unavailable', language: 'python', key: 'a.py' },
    });
    broken = false;
    expect((await s.parse({ key: wp('a.py'), text: '' })).ok).toBe(true);
  });

  it('bytes that are not a grammar are grammar-rejected', async () => {
    const s = make({
      describe: () => 'junk',
      load: () =>
        Promise.resolve({ ok: true, bytes: new Uint8Array([1, 2, 3]), origin: 'junk.wasm' }),
    });
    expect(await s.ensureReady(['python'])).toMatchObject([
      { code: 'grammar-rejected', language: 'python' },
    ]);
  });

  it('after dispose, parse is disposed', async () => {
    const s = make();
    s.dispose();
    expect(await s.parse({ key: wp('a.py'), text: '' })).toMatchObject({
      ok: false,
      error: { code: 'disposed' },
    });
  });
});

describe('grammar loading', () => {
  it('loads each grammar once, shared by concurrent first use (I16)', async () => {
    const reads: string[] = [];
    const s = make(diskSource(reads));
    await Promise.all([1, 2, 3].map((i) => s.parse({ key: wp(`f${String(i)}.py`), text: '' })));
    await s.parse({ key: wp('g.ts'), text: '' });
    await s.parse({ key: wp('h.ts'), text: '' });
    expect(reads).toEqual(['tree-sitter-python.wasm', 'tree-sitter-typescript.wasm']);
    expect(s.stats().grammarLoads).toBe(2);
  });

  it('records provenance with a sha256 of the bytes and the ABI range (I34)', async () => {
    const s = make();
    expect(await s.ensureReady(['python', 'tsx'])).toEqual([]);
    const provenance = s.provenance();
    expect(provenance.map((p) => p.language)).toEqual(['python', 'tsx']);
    for (const p of provenance) {
      expect(p.bytesSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.abiVersion).toBeGreaterThanOrEqual(p.abiSupported.minCompatible);
      expect(p.abiVersion).toBeLessThanOrEqual(p.abiSupported.languageVersion);
      expect(p.origin).toBe(join(WASM_DIR, p.wasmFile));
    }
  });
});

describe('handle lifetime (I24)', () => {
  it('counts live handles, makes release idempotent, and refuses root after release', async () => {
    const s = make();
    const a = await ok(s, 'a.py', 'x = 1\n');
    const b = await ok(s, 'b.py', 'y = 2\n');
    expect(s.stats().liveHandles).toBe(2);
    a.release();
    a.release();
    expect([a.released, s.stats().liveHandles]).toEqual([true, 1]);
    expect(() => a.root).toThrow(HandleReleasedError);
    expect(() => a.diagnostics()).toThrow(HandleReleasedError);
    expect(a.rootType).toBe('module');
    expect(b.root.type).toBe('module');
  });

  it('dispose reports and releases the handles a caller leaked', async () => {
    const s = make();
    const leaked = await ok(s, 'a.py', '');
    expect(s.dispose()).toEqual({ leakedHandles: 1, cachedTreesReleased: 0 });
    expect(leaked.released).toBe(true);
  });

  it('writes no debug dumps and caches no trees (I20, I26)', async () => {
    const s = make();
    await ok(s, 'a.py', '');
    expect(s.stats()).toMatchObject({ debugDumpsWritten: 0, cachedTrees: 0 });
  });

  it('retain and releaseDocument are SEAT and say so', () => {
    const s = make();
    expect(() => s.retain(wp('a.py'))).toThrow(/SEAT/);
    expect(() => s.releaseDocument(wp('a.py'))).toThrow(/SEAT/);
  });
});
