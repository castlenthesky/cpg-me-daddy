// createEngine and index(), from BMO-79's acceptance list, C-CLI (IndexReport, I-20, I-22, P-A),
// C-STORE (merge-filesystem; counts come from the store's receipt) and 03-architecture §5
// (NullGraphStore backs --dry-run). Revision ids are an independent sha256 of the bytes.

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES } from '@cpg/parse';
import { createMemoryStore } from '@cpg/sink';
import type { NodeRow, WriteOp, WriteReceipt } from '@cpg/store';
import { storeErrorCode } from '@cpg/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineSink } from './engine';
import { createEngine } from './engine';
import type { IndexProgress, IndexReport, IndexRequest, StoreTarget } from './port';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tree(spec: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-engine-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(spec)) {
    const abs = join(root, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
  return root;
}

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const keys = (rows: readonly NodeRow[]): string[] =>
  rows.map((n) => `${n.label} ${n.key}`).toSorted();
const TARGET: StoreTarget = { host: 'localhost', port: 6382, graph: 'cpg' };

interface Recorded {
  readonly sink: EngineSink;
  readonly memory: ReturnType<typeof createMemoryStore>;
  readonly ops: WriteOp[];
  readonly calls: string[];
}

/** A MemoryStore that records every call; `receipt` overrides what write() reports. */
function recording(id = 'memory', receipt?: Partial<WriteReceipt>, log: string[] = []): Recorded {
  const memory = createMemoryStore({ id });
  const ops: WriteOp[] = [];
  const calls = log;
  const sink: EngineSink = {
    ...memory,
    async open() {
      calls.push(`${id}.open`);
      return memory.open();
    },
    async close() {
      calls.push(`${id}.close`);
      return memory.close();
    },
    async write(op) {
      calls.push(`${id}.write:start`);
      ops.push(op);
      await new Promise((r) => setTimeout(r, 5));
      const real = await memory.write(op);
      calls.push(`${id}.write:end`);
      return { ...real, ...receipt };
    },
    async onDelta(delta, meta) {
      calls.push(`${id}.onDelta`);
      return memory.onDelta(delta, meta);
    },
    async onSnapshot(payload, meta) {
      calls.push(`${id}.onSnapshot`);
      return memory.onSnapshot(payload, meta);
    },
  };
  return { sink, memory, ops, calls };
}

async function index(
  root: string,
  sinks: readonly EngineSink[],
  o: { dryRun?: boolean; config?: Partial<IndexRequest['config']>; signal?: AbortSignal } = {},
): Promise<{ report: IndexReport; progress: IndexProgress[] }> {
  const engine = createEngine({ version: '1.2.3' }, { sinks });
  const session = o.dryRun === true ? null : await engine.connect(TARGET, { readOnly: false });
  const progress: IndexProgress[] = [];
  const report = await engine.index(
    { config: { root, ...o.config }, session, resumeFrom: null },
    (p) => progress.push(p),
    o.signal ?? new AbortController().signal,
  );
  return { report, progress };
}

const i20 = (w: IndexReport['walk']): number =>
  w.filesIndexed + w.filesExcluded + w.filesUnsupported + w.filesTooLarge + w.filesFailed;

describe('createEngine', () => {
  it('identity names the engine, the front door version and the registry languages', () => {
    const engine = createEngine({ version: '4.5.6' }, { sinks: [] });
    expect(engine.identity).toEqual({
      name: '@cpg/engine',
      version: '4.5.6',
      languages: BUILTIN_LANGUAGES.map((l) => l.id),
    });
  });

  it('connect opens every sink and the session closes them', async () => {
    const a = recording('a');
    const b = recording('b');
    const engine = createEngine({ version: '0' }, { sinks: [a.sink, b.sink] });
    const session = await engine.connect(TARGET, { readOnly: false });
    expect(session.target).toEqual(TARGET);
    expect(await a.memory.stats()).toEqual({
      nodeCount: 0,
      edgeCount: 0,
      beyondMeasuredScale: false,
    });
    await b.memory.stats();
    await session.close();
    for (const m of [a.memory, b.memory])
      expect(await m.stats().then(String, storeErrorCode)).toBe('STORE_NOT_OPEN');
  });
});

describe('index --dry-run (session null): NullGraphStore, no store', () => {
  it('a.ts and b.py: filesIndexed 2, every file revisioned, the sinks untouched', async () => {
    const files = { 'a.ts': 'export const a = 1;\n', 'b.py': 'b = 2\n' };
    const root = await tree(files);
    const r = recording();
    const { report } = await index(root, [r.sink], { dryRun: true });

    expect(report).toMatchObject({
      root,
      walk: {
        filesSeen: 2,
        filesIndexed: 2,
        filesExcluded: 0,
        filesUnsupported: 0,
        filesTooLarge: 0,
        filesFailed: 0,
      },
      files: [
        { path: 'a.ts', revision_id: sha256(files['a.ts']), nodes: 0, edges: 0 },
        { path: 'b.py', revision_id: sha256(files['b.py']), nodes: 0, edges: 0 },
      ],
      // the root DIRECTORY and two FILEs; two HAS_ENTRY, counted by the NullGraphStore
      nodesWritten: 3,
      edgesWritten: 2,
      dryRun: true,
      interrupted: false,
      target: null,
      consumers: [],
    });
    expect(Number.isFinite(report.durationMs) && report.durationMs >= 0).toBe(true);
    expect(r.calls).toEqual([]);
    expect(await r.memory.inspect()).toMatchObject({ highWaterSeq: -1, nodeCount: 0 });
  });
});

describe('index with a session: ONE merge-filesystem op through the sinks', () => {
  it('writes the filesystem tier as one op, no deltas, and reports the receipt counts', async () => {
    const files = { 'a.ts': 'export {};\n', 'n.txt': 'n', 'src/b.py': 'x = 1\n' };
    const root = await tree(files);
    const r = recording('memory', { nodesWritten: 41, edgesWritten: 17 });
    const { report } = await index(root, [r.sink]);

    expect(r.calls).toEqual(['memory.open', 'memory.write:start', 'memory.write:end']);
    expect(r.ops).toHaveLength(1);
    const op = r.ops[0];
    if (op?.kind !== 'merge-filesystem')
      throw new Error(`expected merge-filesystem, got ${op?.kind}`);
    expect(op.moves).toEqual([]);
    expect(op.removals).toEqual([]);
    expect(keys(op.directories)).toEqual(['DIRECTORY .', 'DIRECTORY src']);
    expect(keys(op.files)).toEqual(['FILE a.ts', 'FILE n.txt', 'FILE src/b.py']);
    // an unsupported file is still written by the filesystem tier, with language null
    expect(op.files.find((f) => f.key === 'n.txt')?.properties['language']).toBeNull();
    expect(op.files.find((f) => f.key === 'src/b.py')?.properties).toMatchObject({
      path: 'src/b.py',
      name: 'b.py',
      language: 'python',
      content_hash: sha256(files['src/b.py']),
      revision_id: sha256(files['src/b.py']),
    });
    expect(op.directories.find((d) => d.key === '.')?.properties).toMatchObject({
      path: '.',
      name: '.',
      status: 'ready',
    });
    expect(
      op.links
        .map((l) => `${l.type} ${l.fromLabel}:${l.fromKey} -> ${l.toLabel}:${l.toKey}`)
        .toSorted(),
    ).toEqual([
      'HAS_ENTRY DIRECTORY:. -> DIRECTORY:src',
      'HAS_ENTRY DIRECTORY:. -> FILE:a.ts',
      'HAS_ENTRY DIRECTORY:. -> FILE:n.txt',
      'HAS_ENTRY DIRECTORY:src -> FILE:src/b.py',
    ]);

    expect(report).toMatchObject({
      nodesWritten: 41,
      edgesWritten: 17,
      dryRun: false,
      interrupted: false,
      target: TARGET,
      consumers: ['memory'],
    });
  });

  it('the write lands in MemoryStore: languages from the @cpg/parse registry', async () => {
    const root = await tree({ 'a.ts': '', 'b.tsx': '', 'c.mjs': '', 'd.py': '', 'e.txt': '' });
    const memory = createMemoryStore();
    const { report } = await index(root, [memory]);
    expect(await memory.stats()).toMatchObject({ nodeCount: 6, edgeCount: 5 });
    expect(await memory.nodeKeys('DIRECTORY')).toEqual(['.']);
    const language = async (p: string) =>
      (await memory.readFile(wp(p))).nodes.find((n) => n.label === 'FILE')?.properties['language'];
    expect(await Promise.all(['a.ts', 'b.tsx', 'c.mjs', 'd.py', 'e.txt'].map(language))).toEqual([
      'typescript',
      'tsx',
      'javascript',
      'python',
      undefined, // null is the absent value; merge-on-key prunes it (C-STORE INV-11)
    ]);
    expect(report.walk).toMatchObject({ filesSeen: 5, filesIndexed: 4, filesUnsupported: 1 });
    expect(report.files.map((f) => f.path)).toEqual(['a.ts', 'b.tsx', 'c.mjs', 'd.py']);
  });

  it('writes to every sink, strictly one after another, and lists them as consumers in order', async () => {
    const log: string[] = [];
    const a = recording('a', undefined, log);
    const b = recording('b', undefined, log);
    const root = await tree({ 'm.py': '' });
    const { report } = await index(root, [a.sink, b.sink]);
    expect(log).toEqual([
      'a.open',
      'b.open',
      'a.write:start',
      'a.write:end',
      'b.write:start',
      'b.write:end',
    ]);
    expect(a.ops).toEqual(b.ops);
    expect(report.consumers).toEqual(['a', 'b']);
    // the root DIRECTORY and m.py, one HAS_ENTRY: one write's receipt, not the sum over sinks
    expect(report).toMatchObject({ nodesWritten: 2, edgesWritten: 1 });
  });
});

describe('IndexReport', () => {
  it('files are sorted by path (UTF-16 code units), not in walk order', async () => {
    const root = await tree({ 'b/x.ts': '', 'b.ts': '', 'a.py': '', 'B.py': '' });
    const { report } = await index(root, [], { dryRun: true });
    expect(report.files.map((f) => f.path)).toEqual(['B.py', 'a.py', 'b.ts', 'b/x.ts']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'I-20: seen = indexed + excluded + unsupported + tooLarge + failed; unsupported files are not listed',
    async () => {
      const root = await tree({
        'a.ts': 'x',
        'notes.txt': 'n',
        'types.d.ts': '',
        'big.py': 'y'.repeat(11),
        'locked.py': 'z',
        'node_modules/x.js': '',
      });
      await chmod(join(root, 'locked.py'), 0o000);
      const r = recording();
      try {
        const { report } = await index(root, [r.sink], { config: { maxFileSizeBytes: 10 } });
        expect(report.walk).toEqual({
          filesSeen: 5,
          filesIndexed: 1,
          filesExcluded: 1,
          filesUnsupported: 1,
          filesTooLarge: 1,
          filesFailed: 1,
        });
        expect(i20(report.walk)).toBe(report.walk.filesSeen);
        expect(report.files).toEqual([
          { path: 'a.ts', revision_id: sha256('x'), nodes: 0, edges: 0 },
        ]);
        // the filesystem tier still writes the unsupported file, with no language
        const op = r.ops[0];
        expect(op?.kind === 'merge-filesystem' && op.files.map((f) => f.key).toSorted()).toEqual([
          'a.ts',
          'notes.txt',
        ]);
        expect(
          op?.kind === 'merge-filesystem' &&
            op.files.find((f) => f.key === 'notes.txt')?.properties['language'],
        ).toBeNull();
      } finally {
        await chmod(join(root, 'locked.py'), 0o600);
      }
    },
  );

  it('passes include, exclude and maxFileSizeBytes to the walk', async () => {
    const root = await tree({
      'src/a.ts': '',
      'src/big.ts': '123456',
      'src/skip.ts': '',
      'top.py': '',
    });
    const { report } = await index(root, [], {
      dryRun: true,
      config: { include: ['**/*.ts'], exclude: ['**/skip.ts'], maxFileSizeBytes: 5 },
    });
    expect(report.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(report.walk).toMatchObject({
      filesSeen: 4,
      filesIndexed: 1,
      filesExcluded: 2,
      filesTooLarge: 1,
    });
  });

  it('warns that the code tier is a SEAT on every run, and when no file was indexed', async () => {
    const some = await index(await tree({ 'a.py': '' }), [], { dryRun: true });
    expect(some.report.warnings).toHaveLength(1);
    expect(some.report.warnings[0]).toMatch(/code tier.*U6a/);

    const none = await tree({ 'notes.txt': '' });
    const { report } = await index(none, [], { dryRun: true });
    expect(report.walk.filesIndexed).toBe(0);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings.some((w) => /code tier.*U6a/.test(w))).toBe(true);
    expect(report.warnings.some((w) => w.includes('no files indexed') && w.includes(none))).toBe(
      true,
    );
  });

  it('reports progress after the walk and after the write', async () => {
    const root = await tree({ 'a.py': '', 'n.txt': '' });
    const { progress } = await index(root, [], { dryRun: true });
    expect(progress).toEqual([
      { phase: 'walked', filesTotal: 2 },
      { phase: 'written', filesTotal: 2 },
    ]);

    const log: string[] = [];
    const r = recording('memory', undefined, log);
    const engine = createEngine({ version: '0' }, { sinks: [r.sink] });
    const session = await engine.connect(TARGET, { readOnly: false });
    await engine.index(
      { config: { root }, session, resumeFrom: null },
      (p) => log.push(`progress:${p.phase}`),
      new AbortController().signal,
    );
    expect(log).toEqual([
      'memory.open',
      'progress:walked',
      'memory.write:start',
      'memory.write:end',
      'progress:written',
    ]);
  });
});

describe('interruption and resume', () => {
  it('an aborted signal writes nothing and reports interrupted', async () => {
    const root = await tree({ 'a.py': '', 'b.py': '' });
    const r = recording();
    const { report, progress } = await index(root, [r.sink], { signal: AbortSignal.abort() });
    expect(r.ops).toEqual([]);
    expect(report).toMatchObject({
      interrupted: true,
      files: [],
      nodesWritten: 0,
      edgesWritten: 0,
    });
    expect(i20(report.walk)).toBe(report.walk.filesSeen);
    expect(progress.map((p) => p.phase)).not.toContain('written');
  });

  it('a signal that fires after the walk, before the write, still writes nothing', async () => {
    const root = await tree({ 'a.py': '' });
    const r = recording();
    const engine = createEngine({ version: '0' }, { sinks: [r.sink] });
    const session = await engine.connect(TARGET, { readOnly: false });
    const controller = new AbortController();
    const report = await engine.index(
      { config: { root }, session, resumeFrom: null },
      (p) => {
        if (p.phase === 'walked') controller.abort();
      },
      controller.signal,
    );
    expect(r.ops).toEqual([]);
    expect(report).toMatchObject({
      interrupted: true,
      files: [],
      nodesWritten: 0,
      edgesWritten: 0,
      consumers: [],
    });
  });

  it('a non-null resumeFrom is refused: v1 index is not resumable', async () => {
    const root = await tree({ 'a.py': '' });
    const r = recording();
    const engine = createEngine({ version: '0' }, { sinks: [r.sink] });
    const session = await engine.connect(TARGET, { readOnly: false });
    const req: IndexRequest = { config: { root }, session, resumeFrom: [] };
    await expect(engine.index(req, () => {}, new AbortController().signal)).rejects.toThrow(
      /resum/i,
    );
    expect(r.ops).toEqual([]);
  });
});
