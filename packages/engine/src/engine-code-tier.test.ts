// index()'s code tier (U6a.3-2, BMO-43 part 2), from controller decisions 98a (the write seq is the
// sink's), 100 (bytes once, one ParseService, failure is a warning), 101 (the write order, the counts,
// the warnings), C-STORE INV-3 and DQ-01, C-EXTRACT Q8 (the engine attaches SOURCE_FILE), C-PARSE I19
// and BMO-43's "revision-reconciliation now covers :CPG nodes vs FILE". Ids and ranges are the
// ladder's forms (fixtures/ladder/README.md); revision ids are an independent sha256 of the bytes.

import { createHash } from 'node:crypto';
import type * as Fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ExtractedFile,
  ExtractErrorCode,
  ExtractOutcome,
  ExtractRequest,
  Extractor,
} from '@cpg/extract';
import { createExtractor } from '@cpg/extract';
import type { WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import type { ParseRequest, ParseService } from '@cpg/parse';
import { createParseService } from '@cpg/parse';
import { createMemoryStore, type MemoryStore } from '@cpg/sink';
import type { NodeRow, WriteOp, WriteReceipt } from '@cpg/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineDeps } from './engine';
import { createEngine } from './engine';
import type { CpgEngine, IndexReport, StoreTarget, VerifyReport } from './port';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cpg-code-index-'));
  roots.push(dir);
  return dir;
}
async function put(root: string, spec: Readonly<Record<string, string | Uint8Array>>) {
  for (const [path, contents] of Object.entries(spec)) {
    const abs = join(root, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
}
async function tree(spec: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  const root = await tmp();
  await put(root, spec);
  return root;
}

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
const TARGET: StoreTarget = { host: 'localhost', port: 6382, graph: 'cpg' };
const CONSUMERS = { inspect: false, store: 'memory', vscode: false } as const;
const mod = (path: string): string => `file:${path}:MODULE:$root`;
const cjsRequire = createRequire(__filename);

interface Written {
  readonly op: WriteOp;
  readonly receipt: WriteReceipt;
}
/** The memory store an engine writes, recording every op and the receipt the store gave it. */
function recorded(memory: MemoryStore = createMemoryStore()) {
  const writes: Written[] = [];
  const sink: MemoryStore = {
    ...memory,
    async write(op) {
      const receipt = await memory.write(op);
      writes.push({ op, receipt });
      return receipt;
    },
  };
  return { memory, sink, writes };
}

function engineOn(sink: MemoryStore, deps: EngineDeps = {}, grammarDir?: string): CpgEngine {
  return createEngine(
    { version: '0', consumers: CONSUMERS, ...(grammarDir !== undefined && { grammarDir }) },
    { ...deps, memoryStore: sink },
  );
}

async function indexWith(
  engine: CpgEngine,
  root: string,
  signal = new AbortController().signal,
): Promise<IndexReport> {
  const session = await engine.connect(TARGET, { readOnly: false });
  try {
    return await engine.index({ config: { root }, session, resumeFrom: null }, () => {}, signal);
  } finally {
    await session.close();
  }
}
async function verifyWith(engine: CpgEngine, root: string): Promise<VerifyReport> {
  const session = await engine.connect(TARGET, { readOnly: true });
  try {
    return await engine.verify(session, { root }, null);
  } finally {
    await session.close();
  }
}
const check = (report: VerifyReport, id: string) => report.checks.find((c) => c.id === id);

const kinds = (writes: readonly Written[]): string[] =>
  writes.map(({ op }) =>
    op.kind === 'replace-file' || op.kind === 'delete-file' ? `${op.kind} ${op.file}` : op.kind,
  );
const seqs = (writes: readonly Written[]): number[] =>
  writes.flatMap(({ op }) =>
    op.kind === 'replace-file' || op.kind === 'delete-file' ? [op.seq] : [],
  );
const edgeLines = (op: WriteOp): string[] =>
  op.kind === 'replace-file'
    ? op.edges.map((e) => `${e.type} ${e.fromLabel}:${e.fromKey} -> ${e.toLabel}:${e.toKey}`)
    : [];
const rowOf = (op: WriteOp, label: string): NodeRow | undefined =>
  op.kind === 'replace-file' ? op.nodes.find((n) => n.label === label) : undefined;

/**
 * The store's whole graph, read through a handle of its own: indexWith's session has closed the
 * store, and a read on a closed store is STORE_NOT_OPEN (post-implementation fix of a RED defect).
 */
async function payloadOf(memory: MemoryStore) {
  await memory.open();
  try {
    return await memory.readAll();
  } finally {
    await memory.close();
  }
}
async function nodeData(memory: MemoryStore, id: string) {
  const payload = await payloadOf(memory);
  return payload.nodes.find((n) => n.id === id)?.data;
}
async function filesOwning(memory: MemoryStore): Promise<string[]> {
  const payload = await payloadOf(memory);
  const owned = payload.nodes.flatMap((n) => {
    const file = n.data?.['file'];
    return typeof file === 'string' ? [file] : [];
  });
  return [...new Set(owned)].toSorted();
}

describe('index(): the code tier after the filesystem tier (decision 101)', () => {
  it('merge-filesystem, then one replace-file per python file in walk order, each with SOURCE_FILE', async () => {
    const files = { 'a.py': 'a = 1\n', 'c.ts': 'c', 'd.txt': 'd', 'lib/b.py': 'b = 2\nc = 3' };
    const root = await tree(files);
    const r = recorded();
    const report = await indexWith(engineOn(r.sink), root);

    expect(kinds(r.writes)).toEqual([
      'merge-filesystem',
      'replace-file a.py',
      'replace-file lib/b.py',
    ]);
    const [, a, b] = r.writes;
    if (a?.op.kind !== 'replace-file' || b?.op.kind !== 'replace-file') throw new Error('ops');
    expect([a.op.revision_id, b.op.revision_id]).toEqual([
      sha256(files['a.py']),
      sha256(files['lib/b.py']),
    ]);
    // C-EXTRACT Q8: the engine attaches SOURCE_FILE, after the extracted file's own DEFINES
    expect(edgeLines(a.op)).toEqual([
      `DEFINES MODULE:${mod('a.py')} -> SYMBOL:\`a.py\`/`,
      `SOURCE_FILE MODULE:${mod('a.py')} -> FILE:a.py`,
    ]);
    expect(a.op.edges.at(-1)?.properties).toEqual({});
    expect(rowOf(a.op, 'MODULE')).toMatchObject({
      key: mod('a.py'),
      properties: { name: 'a', file: 'a.py', revision_id: sha256(files['a.py']), range: '1:0-2:0' },
    });
    expect(rowOf(b.op, 'MODULE')?.properties).toMatchObject({ name: 'lib.b', range: '1:0-2:5' });
    expect(rowOf(b.op, 'FILE')?.properties).toMatchObject({ loc: 2 });
    // C-STORE INV-3: each per-file write is one applied statement
    expect(
      r.writes.slice(1).map(({ receipt }) => [receipt.applied, receipt.statementCount]),
    ).toEqual([
      [true, 1],
      [true, 1],
    ]);
    // the counts are the code tier's (stop-list 16); d.txt is not an indexed file
    expect(report.files.map((f) => [f.path, f.nodes, f.edges])).toEqual([
      ['a.py', 1, 2],
      ['c.ts', 0, 0],
      ['lib/b.py', 1, 2],
    ]);
    expect(report.warnings).toEqual(['no extractor for typescript yet (U6b)']);
  });

  it('a UTF-8 BOM: the revision hashes the raw bytes, the MODULE range starts after the BOM', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('x = 1')]);
    const root = await tree({ 'b.py': bytes });
    const r = recorded();
    await indexWith(engineOn(r.sink), root);
    expect(await nodeData(r.memory, mod('b.py'))).toMatchObject({
      range: '1:0-1:5',
      revision_id: sha256(bytes),
    });
  });
});

// Round two (review 5): walk order and path order differ here ('a/' sorts before 'a.py' in its
// directory, after it as a path), so writing in report.files order is wrong.
describe('index(): replace-files follow the walk, not the sorted report', () => {
  it('a/z.py before a.py; report.files stays sorted by path', async () => {
    const r = recorded();
    const report = await indexWith(engineOn(r.sink), await tree({ 'a/z.py': 'z', 'a.py': 'a' }));
    expect(kinds(r.writes)).toEqual([
      'merge-filesystem',
      'replace-file a/z.py',
      'replace-file a.py',
    ]);
    expect(report.files.map((f) => f.path)).toEqual(['a.py', 'a/z.py']);
  });
});

describe('the write seq is the sink allocator (decision 98a)', () => {
  it('every replace-file and delete-file seq comes from the store, above a seq written before', async () => {
    const memory = createMemoryStore();
    await memory.open();
    await memory.write({ kind: 'delete-file', file: wp('elsewhere.py'), seq: 100 });
    await memory.close();
    const r = recorded(memory);
    await indexWith(engineOn(r.sink), await tree({ 'a.py': 'a', 'b.py': 'b' }));
    expect(seqs(r.writes)).toEqual([101, 102]);
  });

  it('monotone across index() runs: an unchanged file is revision-unchanged, an edited one applies', async () => {
    const root = await tree({ 'a.py': 'a = 1\n' });
    const r = recorded();
    const engine = engineOn(r.sink);
    await indexWith(engine, root);
    const second = await indexWith(engine, root);
    await writeFile(join(root, 'a.py'), 'a = 2\n');
    await indexWith(engine, root);

    expect(seqs(r.writes)).toEqual([0, 1, 2]);
    expect(r.writes.map(({ receipt }) => receipt.applied)).toEqual([
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
    expect(r.writes[3]?.receipt.notApplied).toEqual({
      reason: 'revision-unchanged',
      revision_id: sha256('a = 1\n'),
    });
    // counts are the extraction's; the written totals are the receipts' (the replace-file wrote 0)
    expect(second.files).toEqual([
      { path: 'a.py', revision_id: sha256('a = 1\n'), nodes: 1, edges: 2 },
    ]);
    expect([second.nodesWritten, second.edgesWritten]).toEqual([2, 1]);
  });
});

// Round two (review 3): the engine asks the store for every seq, so it never caches one between runs.
describe('the engine holds no seq of its own (decision 98a)', () => {
  it('a seq written directly between two index() runs is below the next run', async () => {
    const root = await tree({ 'a.py': 'a = 1\n' });
    const r = recorded();
    const engine = engineOn(r.sink);
    await indexWith(engine, root);
    await r.memory.open();
    await r.memory.write({ kind: 'delete-file', file: wp('elsewhere.py'), seq: 50 });
    await writeFile(join(root, 'a.py'), 'a = 2\n');
    await indexWith(engine, root);
    expect(seqs(r.writes)).toEqual([0, 51]);
  });
});

describe('DQ-01: the FILE carries both tiers, each owning its own properties', () => {
  it('filesystem properties from merge-filesystem, code properties from replace-file; version counts writes', async () => {
    const root = await tree({ 'a.py': 'a = 1\n' });
    const r = recorded();
    const engine = engineOn(r.sink);
    await indexWith(engine, root);
    expect(await nodeData(r.memory, 'file:a.py')).toMatchObject({
      path: 'a.py',
      language: 'python',
      revision_id: sha256('a = 1\n'),
      status: 'ready',
      version: 1,
      loc: 2,
      interface_hash: expect.any(String),
    });
    await writeFile(join(root, 'a.py'), 'a = 1\nb = 2\nc = 3\n');
    await indexWith(engine, root);
    expect(await nodeData(r.memory, 'file:a.py')).toMatchObject({
      revision_id: sha256('a = 1\nb = 2\nc = 3\n'),
      version: 2,
      loc: 4,
    });
    expect(await nodeData(r.memory, mod('a.py'))).toMatchObject({
      revision_id: sha256('a = 1\nb = 2\nc = 3\n'),
      range: '1:0-4:0',
    });
  });
});

describe('removals (decisions 77, 101): delete-file for each removed path the store held code for', () => {
  it('after the replace-files; never for a path with no code; SYMBOLs stay (decision 104)', async () => {
    const root = await tree({ 'a.py': 'a', 'b.py': 'b', 'pkg/c.py': 'c', 'd.ts': 'd' });
    const r = recorded();
    const engine = engineOn(r.sink);
    await indexWith(engine, root);
    await unlink(join(root, 'b.py'));
    await unlink(join(root, 'd.ts'));
    await rm(join(root, 'pkg'), { recursive: true });
    const before = r.writes.length;
    await indexWith(engine, root);

    const run = r.writes.slice(before);
    const [fs, ...rest] = run;
    expect(fs?.op.kind === 'merge-filesystem' && [...fs.op.removals].toSorted()).toEqual([
      'b.py',
      'd.ts',
      'pkg',
      'pkg/c.py',
    ]);
    expect(kinds(rest).slice(0, 1)).toEqual(['replace-file a.py']);
    expect(kinds(rest.slice(1)).toSorted()).toEqual(['delete-file b.py', 'delete-file pkg/c.py']);
    expect(rest.map(({ receipt }) => receipt.statementCount)).toEqual([1, 1, 1]);
    const order = seqs(run);
    expect(order).toEqual(order.toSorted((x, y) => x - y));
    expect(new Set(order).size).toBe(order.length);

    expect(await filesOwning(r.memory)).toEqual(['a.py']);
    const symbols = (await payloadOf(r.memory)).nodes
      .filter((n) => n.type === 'SYMBOL')
      .map((n) => n.id);
    expect(symbols.toSorted()).toEqual(['`a.py`/', '`b.py`/', '`pkg/c.py`/']);
    const verified = await verifyWith(engine, root);
    expect([
      check(verified, 'filesystem-reconciliation')?.state,
      check(verified, 'revision-reconciliation')?.state,
    ]).toEqual(['pass', 'pass']);
  });
});

// Round two (review 6): the criterion is the store's own file-owned nodes, not the path's language.
const fileRow = (path: string): NodeRow => ({
  label: 'FILE',
  key: path,
  properties: { path, name: path, revision_id: '5d'.repeat(32) },
});
describe('removals: what the store held decides, not the extension', () => {
  it('a removed .ts holding a MODULE gets a delete-file; a removed .py holding none gets none', async () => {
    const memory = createMemoryStore();
    await memory.open();
    await memory.write({
      kind: 'merge-filesystem',
      directories: [],
      files: [fileRow('x.ts'), fileRow('y.py')],
      links: [],
      moves: [],
      removals: [],
    });
    await memory.write({
      kind: 'replace-file',
      file: wp('x.ts'),
      seq: 3,
      revision_id: '5d'.repeat(32),
      nodes: [
        {
          label: 'MODULE',
          key: mod('x.ts'),
          properties: { name: 'x', file: 'x.ts', revision_id: '5d'.repeat(32), range: '1:0-1:1' },
        },
      ],
      edges: [],
    });
    await memory.close();
    const r = recorded(memory);
    await indexWith(engineOn(r.sink), await tree({ 'a.py': 'a' }));
    const [fs, ...rest] = r.writes;
    expect(fs?.op.kind === 'merge-filesystem' && [...fs.op.removals].toSorted()).toEqual([
      'x.ts',
      'y.py',
    ]);
    expect(kinds(rest)).toEqual(['replace-file a.py', 'delete-file x.ts']);
    expect(seqs(rest)).toEqual([4, 5]);
    expect(await filesOwning(r.memory)).toEqual(['a.py']);
  });
});

// Post-implementation (sabotage: the held set without its label filter survived): only file-owned
// labels count as code a path held. An identity node may carry a `file` (C-STORE INV-12 never deletes
// one), and a removed path that holds nothing else gets no delete-file.
describe('removals: an identity node carrying a file is not code held for it', () => {
  it('a removed z.py whose only node with file z.py is a SYMBOL gets no delete-file', async () => {
    const memory = createMemoryStore();
    await memory.open();
    await memory.write({
      kind: 'merge-filesystem',
      directories: [],
      files: [fileRow('x.ts'), fileRow('z.py')],
      links: [],
      moves: [],
      removals: [],
    });
    const symbol = '`z.py`/';
    const planted = await memory.write({
      kind: 'replace-file',
      file: wp('x.ts'),
      seq: 3,
      revision_id: '5d'.repeat(32),
      nodes: [
        {
          label: 'MODULE',
          key: mod('x.ts'),
          properties: { name: 'x', file: 'x.ts', revision_id: '5d'.repeat(32), range: '1:0-1:1' },
        },
        {
          label: 'SYMBOL',
          key: symbol,
          properties: { fqn: symbol, language: 'python', kind: 'module', file: 'z.py' },
        },
      ],
      edges: [],
    });
    await memory.close();
    expect(planted.applied).toBe(true);
    const r = recorded(memory);
    await indexWith(engineOn(r.sink), await tree({ 'a.py': 'a' }));
    expect(kinds(r.writes.slice(1))).toEqual(['replace-file a.py', 'delete-file x.ts']);
  });
});

describe('a code tier failure is a warning, never fatal (decision 100)', () => {
  it('a grammarDir without the grammar: FILE tier only, one warning for every python file', async () => {
    const empty = await tmp();
    const root = await tree({ 'a.py': 'a', 'b/c.py': 'c', 'd.ts': 'd' });
    const r = recorded();
    const report = await indexWith(engineOn(r.sink, {}, empty), root);
    expect(kinds(r.writes)).toEqual(['merge-filesystem']);
    expect(report.files.map((f) => f.nodes + f.edges)).toEqual([0, 0, 0]);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[0]).toBe('no extractor for typescript yet (U6b)');
    expect(report.warnings[1]).toMatch(
      /^code tier: 2 python files at the FILE tier only \(grammar-unavailable\): a\.py: /,
    );
    expect(report.warnings[1]).toContain(join(empty, 'tree-sitter-python.wasm'));
  });

  it('a relative grammarDir is refused by the locator: one file, one warning, singular', async () => {
    const report = await indexWith(
      engineOn(recorded().sink, {}, 'wasm'),
      await tree({ 'a.py': 'a' }),
    );
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(
      /^code tier: 1 python file at the FILE tier only \(grammar-unavailable\): a\.py: .*must be an absolute path/,
    );
  });

  it('one file failing extract does not stop the others; a failed file keeps the code it had', async () => {
    const root = await tree({ 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' });
    const r = recorded();
    await indexWith(engineOn(r.sink), root);
    const real = createExtractor();
    const flaky: Extractor = {
      ...real,
      extract: (request) =>
        request.path === 'b.py'
          ? { kind: 'failed', error: { code: 'internal', message: 'b broke', path: request.path } }
          : real.extract(request),
    };
    await writeFile(join(root, 'a.py'), 'a = 2\n');
    await writeFile(join(root, 'b.py'), 'b = 2\n');
    const engine = engineOn(r.sink, { extractor: flaky });
    const before = r.writes.length;
    const report = await indexWith(engine, root);

    expect(kinds(r.writes.slice(before))).toEqual(['merge-filesystem', 'replace-file a.py']);
    expect(report.warnings).toEqual([
      'code tier: 1 python file at the FILE tier only (internal): b.py: b broke',
    ]);
    expect(report.files.map((f) => [f.path, f.nodes])).toEqual([
      ['a.py', 1],
      ['b.py', 0],
    ]);
    // b.py keeps its MODULE at the old revision, and revision-reconciliation says so (BMO-43)
    expect(await nodeData(r.memory, mod('b.py'))).toMatchObject({ revision_id: sha256('b = 1\n') });
    const stale = check(await verifyWith(engine, root), 'revision-reconciliation');
    expect([stale?.state, stale?.observed, stale?.localisedTo]).toEqual(['fail', 1, ['b.py']]);
  });
});

// Round two (reviews 7, 8): one warning per (language, code) in the order each first failed, with
// the first path and message; then the bridge warnings; the no-extractor warning comes first.
describe('the warnings together (decision 101)', () => {
  it('no extractor, then one per failure group by first failure, then no MODULE', async () => {
    const real = createExtractor();
    const failing: Readonly<Record<string, readonly [ExtractErrorCode, string]>> = {
      'a.py': ['root-type-mismatch', 'a broke'],
      'b.py': ['internal', 'b broke'],
      'c.py': ['internal', 'c broke'],
    };
    const mixed: Extractor = {
      ...real,
      extract: (request) => {
        const fail = failing[request.path];
        if (fail !== undefined)
          return { kind: 'failed', error: { code: fail[0], message: fail[1], path: request.path } };
        const got = real.extract(request);
        return got.kind === 'ok' && request.path === 'd.py'
          ? { kind: 'ok', file: { ...got.file, nodes: [], symbols: [], edges: [] } }
          : got;
      },
    };
    const root = await tree({ 'a.py': 'a', 'b.py': 'b', 'c.py': 'c', 'd.py': 'd', 'e.ts': 'e' });
    const report = await indexWith(engineOn(recorded().sink, { extractor: mixed }), root);
    expect(report.warnings).toEqual([
      'no extractor for typescript yet (U6b)',
      'code tier: 1 python file at the FILE tier only (root-type-mismatch): a.py: a broke',
      'code tier: 2 python files at the FILE tier only (internal): b.py: b broke',
      'code tier: d.py: no MODULE, so no SOURCE_FILE edge',
    ]);
  });
});

describe('revision-reconciliation covers code nodes vs FILE (BMO-43)', () => {
  it('a filesystem-only write that moves the FILE leaves the MODULE stale until the next index', async () => {
    const root = await tree({ 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' });
    const r = recorded();
    const engine = engineOn(r.sink);
    await indexWith(engine, root);
    expect(check(await verifyWith(engine, root), 'revision-reconciliation')?.state).toBe('pass');

    // what a watch batch writes today: the FILE at the new bytes' revision, nothing for the code tier
    await writeFile(join(root, 'a.py'), 'a = 2\n');
    await r.memory.open();
    await r.memory.write({
      kind: 'merge-filesystem',
      directories: [],
      files: [
        {
          label: 'FILE',
          key: 'a.py',
          properties: { path: 'a.py', revision_id: sha256('a = 2\n') },
        },
      ],
      links: [],
      moves: [],
      removals: [],
    });
    const stale = check(await verifyWith(engine, root), 'revision-reconciliation');
    expect([stale?.state, stale?.observed, stale?.localisedTo]).toEqual(['fail', 1, ['a.py']]);

    await indexWith(engine, root);
    expect(check(await verifyWith(engine, root), 'revision-reconciliation')?.state).toBe('pass');
  });
});

describe('the extractor decides which languages run (decision 96)', () => {
  it('an extractor for typescript runs the code tier for .ts and names python as having none', async () => {
    const asked: ExtractRequest[] = [];
    const ts: Extractor = {
      ...createExtractor(),
      grammars: ['typescript'],
      extract: (request): ExtractOutcome => {
        asked.push(request);
        const file: ExtractedFile = {
          path: request.path,
          grammarId: request.grammarId,
          revision_id: request.revision_id,
          nodes: [
            {
              label: 'MODULE',
              id: mod(request.path),
              file: request.path,
              revision_id: request.revision_id,
              tier: 'structural',
              range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 },
              properties: { name: 'a' },
            },
          ],
          symbols: [],
          edges: [],
          refSites: [],
          stats: { astNodesVisited: 1, structuralNodes: 1, expressionNodes: 0, lineCount: 1 },
          elementDigest: 'd',
          interfaceHash: 'h',
        };
        return { kind: 'ok', file };
      },
    };
    const r = recorded();
    const report = await indexWith(
      engineOn(r.sink, { extractor: ts }),
      await tree({ 'a.ts': 'a', 'b.py': 'b' }),
    );
    expect(asked.map((q) => [q.path, q.grammarId])).toEqual([['a.ts', 'typescript']]);
    expect(kinds(r.writes)).toEqual(['merge-filesystem', 'replace-file a.ts']);
    expect(report.files.map((f) => [f.path, f.nodes, f.edges])).toEqual([
      ['a.ts', 1, 1],
      ['b.py', 0, 0],
    ]);
    expect(report.warnings).toEqual(['no extractor for python yet (U6b)']);
  });

  it('an extracted file with no MODULE is written without SOURCE_FILE, and said', async () => {
    const real = createExtractor();
    const bare: Extractor = {
      ...real,
      extract: (request) => {
        const got = real.extract(request);
        return got.kind === 'ok'
          ? { kind: 'ok', file: { ...got.file, nodes: [], symbols: [], edges: [] } }
          : got;
      },
    };
    const r = recorded();
    const report = await indexWith(
      engineOn(r.sink, { extractor: bare }),
      await tree({ 'a.py': 'a' }),
    );
    expect(kinds(r.writes)).toEqual(['merge-filesystem', 'replace-file a.py']);
    expect(r.writes[1] && edgeLines(r.writes[1].op)).toEqual([]);
    expect(report.files).toEqual([{ path: 'a.py', revision_id: sha256('a'), nodes: 0, edges: 0 }]);
    expect(report.warnings).toEqual(['code tier: a.py: no MODULE, so no SOURCE_FILE edge']);
  });
});

/** createParseService, recording each service made and each parse it is asked for. */
function parseRig(onParse: (request: ParseRequest, service: ParseService) => void = () => {}) {
  const services: ParseService[] = [];
  const requests: ParseRequest[] = [];
  const liveAtParse: number[] = [];
  const make: EngineDeps['createParseService'] = (options) => {
    const service = createParseService(options);
    services.push(service);
    return {
      ...service,
      parse: (request) => {
        requests.push(request);
        liveAtParse.push(service.stats().liveHandles);
        onParse(request, service);
        return service.parse(request);
      },
    };
  };
  return { make, services, requests, liveAtParse };
}

describe('one ParseService per engine, bytes read once (decision 100; C-PARSE I19)', () => {
  it('none until the first python file; one for every index after; never two live trees', async () => {
    const p = parseRig();
    const engine = engineOn(recorded().sink, { createParseService: p.make });
    await indexWith(engine, await tree({ 'a.ts': 'a', 'n.txt': 'n' }));
    expect(p.services).toHaveLength(0);
    const root = await tree({ 'a.py': 'a', 'b.py': 'b', 'c/d.py': 'd' });
    await indexWith(engine, root);
    await indexWith(engine, root);
    expect(p.services).toHaveLength(1);
    expect(p.requests).toHaveLength(6);
    expect(p.liveAtParse).toEqual([0, 0, 0, 0, 0, 0]);
    expect(p.services[0]?.stats().liveHandles).toBe(0);
    // another engine, another service
    const other = parseRig();
    await indexWith(engineOn(recorded().sink, { createParseService: other.make }), root);
    expect([p.services.length, other.services.length]).toEqual([1, 1]);
  });

  it('PARSE gets the decoded text of the walk read, which is the only read of the file', async () => {
    const root = await tree({ 'a.py': 'é = 1\n', 'n.txt': 'n' });
    const fsp: typeof FsPromises = cjsRequire('node:fs/promises');
    const fs: typeof Fs = cjsRequire('node:fs');
    // a spy calls through, so the walk still reads; every call is recorded
    const asyncReads = vi.spyOn(fsp, 'readFile');
    const syncReads = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    const p = parseRig();
    const report = await indexWith(engineOn(recorded().sink, { createParseService: p.make }), root);

    const reads = [...asyncReads.mock.calls, ...syncReads.mock.calls].flatMap(([path]) =>
      typeof path === 'string' ? [path] : [],
    );
    expect(reads.filter((path) => path.startsWith(root)).toSorted()).toEqual([
      join(root, 'a.py'),
      join(root, 'n.txt'),
    ]);
    expect(p.requests).toStrictEqual([{ key: 'a.py', text: 'é = 1\n', language: 'python' }]);
    expect(report.files[0]?.nodes).toBe(1);
  });

  // Round two (review 9): an already-aborted signal parses nothing at all, not even the first file.
  it('an aborted signal before the index builds no service and parses nothing', async () => {
    const p = parseRig();
    const r = recorded();
    const root = await tree({ 'a.py': 'a', 'b.py': 'b' });
    const report = await indexWith(
      engineOn(r.sink, { createParseService: p.make }),
      root,
      AbortSignal.abort(),
    );
    expect([p.services, p.requests, r.writes, report.interrupted]).toEqual([[], [], [], true]);
  });

  it('an abort during the code tier parses nothing more and writes nothing', async () => {
    const controller = new AbortController();
    const p = parseRig(() => controller.abort());
    const r = recorded();
    const root = await tree({ 'a.py': 'a', 'b.py': 'b', 'c.py': 'c' });
    const report = await indexWith(
      engineOn(r.sink, { createParseService: p.make }),
      root,
      controller.signal,
    );
    expect(p.requests.map((q) => q.key)).toEqual(['a.py']);
    expect(r.writes).toEqual([]);
    expect(report).toMatchObject({
      interrupted: true,
      files: [],
      nodesWritten: 0,
      edgesWritten: 0,
    });
  });
});
