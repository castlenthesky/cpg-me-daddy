// createEngine and index(), from BMO-79's acceptance list, C-CLI (IndexReport, I-20, I-22, P-A),
// C-STORE (merge-filesystem; counts come from the store's receipt) and 03-architecture §5
// (NullGraphStore backs --dry-run). Revision ids are an independent sha256 of the bytes.
// U2c.2 (BMO-41, owner decision 5a): createEngine builds its own sinks from the consumer switches.
// The memory store is always on (03-architecture §8); `memoryStore` substitutes its instance so a
// test can record it; `sinks` are host-adapter sinks, written after it. falkor (U5) and vscode (U3)
// are SEATs that connect() refuses before opening anything; inspect is built (U2b.1 part 3b).

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CPG_SCHEMA, isWorkspacePath, makeNodeId, type WorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES } from '@cpg/parse';
import { createMemoryStore, type MemoryStore } from '@cpg/sink';
import type { NodeRow, WriteOp, WriteReceipt } from '@cpg/store';
import { storeErrorCode } from '@cpg/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineSink } from './engine';
import { createEngine } from './engine';
import type {
  ConsumerSwitches,
  IndexProgress,
  IndexReport,
  IndexRequest,
  StoreTarget,
} from './port';

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
const HEADLESS: ConsumerSwitches = { inspect: false, store: 'memory', vscode: false };

interface EngineOptions {
  /** Substitutes the built-in memory store's instance. */
  readonly memory?: MemoryStore | undefined;
  /** Host-adapter sinks. */
  readonly sinks?: readonly EngineSink[];
  readonly consumers?: Partial<ConsumerSwitches>;
  readonly version?: string;
}
const engineWith = (o: EngineOptions = {}) =>
  createEngine(
    { version: o.version ?? '0', consumers: { ...HEADLESS, ...o.consumers } },
    {
      ...(o.memory !== undefined && { memoryStore: o.memory }),
      ...(o.sinks !== undefined && { sinks: o.sinks }),
    },
  );

interface Recorded {
  readonly sink: MemoryStore;
  readonly memory: ReturnType<typeof createMemoryStore>;
  readonly ops: WriteOp[];
  readonly calls: string[];
}

/** A MemoryStore that records every call; `receipt` overrides what write() reports. */
function recording(id = 'memory', receipt?: Partial<WriteReceipt>, log: string[] = []): Recorded {
  const memory = createMemoryStore({ id });
  const ops: WriteOp[] = [];
  const calls = log;
  const sink: MemoryStore = {
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
  memory: MemoryStore | undefined,
  o: {
    dryRun?: boolean;
    config?: Partial<IndexRequest['config']>;
    signal?: AbortSignal;
    sinks?: readonly EngineSink[];
  } = {},
): Promise<{ report: IndexReport; progress: IndexProgress[] }> {
  const engine = engineWith({ memory, version: '1.2.3', ...(o.sinks && { sinks: o.sinks }) });
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
    const engine = engineWith({ version: '4.5.6' });
    expect(engine.identity).toEqual({
      name: '@cpg/engine',
      version: '4.5.6',
      languages: BUILTIN_LANGUAGES.map((l) => l.id),
    });
  });

  it('connect opens every sink (built-in, then host) and the session closes them', async () => {
    const log: string[] = [];
    const a = recording('memory', undefined, log);
    const b = recording('b', undefined, log);
    const engine = engineWith({ memory: a.sink, sinks: [b.sink] });
    const session = await engine.connect(TARGET, { readOnly: false });
    expect(session.target).toEqual(TARGET);
    expect(await a.memory.stats()).toEqual({
      nodeCount: 0,
      edgeCount: 0,
      beyondMeasuredScale: false,
    });
    await b.memory.stats();
    expect(log).toEqual(['memory.open', 'b.open']);
    await session.close();
    for (const m of [a.memory, b.memory])
      expect(await m.stats().then(String, storeErrorCode)).toBe('STORE_NOT_OPEN');
  });

  it('schema() is CPG_SCHEMA itself, with no sink opened (U2a.4: what cpg schema prints and checks)', async () => {
    const a = recording('a');
    const engine = engineWith({ memory: a.sink });
    expect(engine.schema()).toBe(CPG_SCHEMA);
    expect(await a.memory.stats().then(String, storeErrorCode)).toBe('STORE_NOT_OPEN');
  });
});

describe('index --dry-run (session null): NullGraphStore, no store', () => {
  it('a.ts and b.py: filesIndexed 2, every file revisioned, the sinks untouched', async () => {
    const files = { 'a.ts': 'export const a = 1;\n', 'b.py': 'b = 2\n' };
    const root = await tree(files);
    const r = recording();
    const { report } = await index(root, r.sink, { dryRun: true });

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
    const { report } = await index(root, r.sink);

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
      // the memory store dials no target (decision 139: naming 127.0.0.1:6382 would mislead)
      target: null,
      consumers: ['memory'],
    });
  });

  it('the write lands in MemoryStore: languages from the @cpg/parse registry', async () => {
    const root = await tree({ 'a.ts': '', 'b.tsx': '', 'c.mjs': '', 'd.py': '', 'e.txt': '' });
    const memory = createMemoryStore();
    const { report } = await index(root, memory);
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

  it('writes the built-in store, then each host sink, strictly one after another, and lists them in order', async () => {
    const log: string[] = [];
    const a = recording('memory', undefined, log);
    const b = recording('b', undefined, log);
    const c = recording('c', undefined, log);
    const root = await tree({ 'm.py': '' });
    const { report } = await index(root, a.sink, { sinks: [b.sink, c.sink] });
    expect(log).toEqual([
      'memory.open',
      'b.open',
      'c.open',
      'memory.write:start',
      'memory.write:end',
      'b.write:start',
      'b.write:end',
      'c.write:start',
      'c.write:end',
    ]);
    expect(a.ops).toEqual(b.ops);
    expect(b.ops).toEqual(c.ops);
    expect(report.consumers).toEqual(['memory', 'b', 'c']);
    // the root DIRECTORY and m.py, one HAS_ENTRY: one write's receipt, not the sum over sinks
    expect(report).toMatchObject({ nodesWritten: 2, edgesWritten: 1 });
  });
});

describe('IndexReport', () => {
  it('files are sorted by path (UTF-16 code units), not in walk order', async () => {
    const root = await tree({ 'b/x.ts': '', 'b.ts': '', 'a.py': '', 'B.py': '' });
    const { report } = await index(root, undefined, { dryRun: true });
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
        const { report } = await index(root, r.sink, { config: { maxFileSizeBytes: 10 } });
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
    const { report } = await index(root, undefined, {
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
    const some = await index(await tree({ 'a.py': '' }), undefined, { dryRun: true });
    expect(some.report.warnings).toHaveLength(1);
    expect(some.report.warnings[0]).toMatch(/code tier.*U6a/);

    const none = await tree({ 'notes.txt': '' });
    const { report } = await index(none, undefined, { dryRun: true });
    expect(report.walk.filesIndexed).toBe(0);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings.some((w) => /code tier.*U6a/.test(w))).toBe(true);
    expect(report.warnings.some((w) => w.includes('no files indexed') && w.includes(none))).toBe(
      true,
    );
  });

  it('reports progress after the walk and after the write', async () => {
    const root = await tree({ 'a.py': '', 'n.txt': '' });
    const { progress } = await index(root, undefined, { dryRun: true });
    expect(progress).toEqual([
      { phase: 'walked', filesTotal: 2 },
      { phase: 'written', filesTotal: 2 },
    ]);

    const log: string[] = [];
    const r = recording('memory', undefined, log);
    const engine = engineWith({ memory: r.sink });
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
    const { report, progress } = await index(root, r.sink, { signal: AbortSignal.abort() });
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
    const engine = engineWith({ memory: r.sink });
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
      // round two (review a1): the interrupted branch reports no target either
      target: null,
      consumers: [],
    });
  });

  it('a non-null resumeFrom is refused: v1 index is not resumable', async () => {
    const root = await tree({ 'a.py': '' });
    const r = recording();
    const engine = engineWith({ memory: r.sink });
    const session = await engine.connect(TARGET, { readOnly: false });
    const req: IndexRequest = { config: { root }, session, resumeFrom: [] };
    await expect(engine.index(req, () => {}, new AbortController().signal)).rejects.toThrow(
      /resum/i,
    );
    expect(r.ops).toEqual([]);
  });
});

describe('createEngine builds its sinks from the consumer switches (owner decision 5a)', () => {
  it('with no deps, a session index writes the engine-built memory store: consumers [memory]', async () => {
    const root = await tree({ 'a.ts': 'export const a = 1;\n', 'b.py': 'b = 2\n' });
    const engine = createEngine({ version: '0', consumers: HEADLESS });
    const session = await engine.connect(TARGET, { readOnly: false });
    const report = await engine.index(
      { config: { root }, session, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    await session.close();
    // the root DIRECTORY and two FILEs, two HAS_ENTRY: the memory store's own receipt
    expect(report).toMatchObject({
      nodesWritten: 3,
      edgesWritten: 2,
      dryRun: false,
      target: null,
      consumers: ['memory'],
    });
  });

  it('builds a new memory store per engine: nothing is shared between two engines', async () => {
    const root = await tree({ 'a.ts': '' });
    const first = createEngine({ version: '0', consumers: HEADLESS });
    const second = createEngine({ version: '0', consumers: HEADLESS });
    const s1 = await first.connect(TARGET, { readOnly: false });
    await first.index(
      { config: { root }, session: s1, resumeFrom: null },
      () => {},
      AbortSignal.timeout(60_000),
    );
    await s1.close();
    const s2 = await second.connect(TARGET, { readOnly: true });
    const report = await second.verify(s2, { root }, null);
    await s2.close();
    expect(report.checks.find((c) => c.id === 'filesystem-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 0,
      expected: 1,
    });
  });

  it.each([
    ['store falkor', { store: 'falkor' }, /consumers\.store falkor.*FalkorStore.*U5/],
  ] as const)(
    '%s: connect refuses with a labelled SEAT and opens no sink',
    async (_name, consumers, message) => {
      const log: string[] = [];
      const memory = recording('memory', undefined, log);
      const host = recording('host', undefined, log);
      const engine = engineWith({ memory: memory.sink, sinks: [host.sink], consumers });
      await expect(engine.connect(TARGET, { readOnly: false })).rejects.toThrow(/^SEAT: /);
      await expect(engine.connect(TARGET, { readOnly: false })).rejects.toThrow(message);
      expect(log).toEqual([]);
      // round two (review a3): only the switch that is on is named
      const refusal = await engine.connect(TARGET, { readOnly: false }).then(
        () => '',
        (e: unknown) => String(e),
      );
      const named = ['consumers.store', 'consumers.inspect', 'consumers.vscode'].filter((k) =>
        refusal.includes(k),
      );
      expect(named).toHaveLength(1);
    },
  );

  // round two (review a2): host sinks alone never replace the always-on memory store
  it('host sinks without a memoryStore: the engine still builds its memory store, first', async () => {
    const root = await tree({ 'm.py': '' });
    const log: string[] = [];
    const host = recording('host', undefined, log);
    const engine = engineWith({ sinks: [host.sink] });
    const session = await engine.connect(TARGET, { readOnly: false });
    const report = await engine.index(
      { config: { root }, session, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    await session.close();
    expect(report.consumers).toEqual(['memory', 'host']);
    // the root DIRECTORY and m.py, one HAS_ENTRY: the built-in store's receipt, not the host's
    expect(report).toMatchObject({ nodesWritten: 2, edgesWritten: 1 });
    expect(host.ops).toHaveLength(1);
    const verified = await engine.verify(
      await engine.connect(TARGET, { readOnly: true }),
      { root },
      null,
    );
    expect(verified.consumers).toEqual(['memory']);
  });

  it('only a switch that is not built is named in the refusal: falkor, never vscode or inspect', async () => {
    const engine = engineWith({ consumers: { store: 'falkor', inspect: true, vscode: true } });
    const refusal = await engine.connect(TARGET, { readOnly: true }).then(
      () => '',
      (e: unknown) => String(e),
    );
    expect(refusal).toContain('consumers.store');
    // U2b.1 part 3b: the inspector is built, so it is never named (stop-list 44, the engine copy)
    expect(refusal).not.toContain('consumers.inspect');
    // Decision 25: the panel lives in the VS Code host, so the engine has nothing to build for it.
    expect(refusal).not.toContain('consumers.vscode');
  });

  // Decision 25 (03-architecture §11): the extension passes `consumers { vscode: true }`.
  it('vscode true: connect opens every sink and index writes memory, as for any other switch', async () => {
    const root = await tree({ 'a.ts': '' });
    const log: string[] = [];
    const memory = recording('memory', undefined, log);
    const host = recording('host', undefined, log);
    const engine = engineWith({
      memory: memory.sink,
      sinks: [host.sink],
      consumers: { vscode: true },
    });
    const session = await engine.connect(TARGET, { readOnly: false });
    const report = await engine.index(
      { config: { root }, session, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    await session.close();
    expect(report.consumers).toEqual(['memory', 'host']);
    expect(memory.ops).toHaveLength(1);
    expect(host.ops).toHaveLength(1);
    expect(log.length).toBeGreaterThan(0);
  });

  it('vscode true: verify reads the built-in store through a read session', async () => {
    const root = await tree({ 'a.ts': '' });
    const engine = engineWith({ consumers: { vscode: true } });
    const w = await engine.connect(TARGET, { readOnly: false });
    await engine.index(
      { config: { root }, session: w, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    await w.close();
    const r = await engine.connect(TARGET, { readOnly: true });
    const report = await engine.verify(r, { root }, null);
    await r.close();
    expect(report.consumers).toEqual(['memory']);
    expect(report.checks.find((c) => c.id === 'filesystem-reconciliation')?.state).toBe('pass');
  });

  it('a dry run opens no sink, so it runs under any switches and reports no consumer', async () => {
    const root = await tree({ 'a.ts': '' });
    const log: string[] = [];
    const memory = recording('memory', undefined, log);
    const engine = engineWith({
      memory: memory.sink,
      consumers: { store: 'falkor', inspect: true, vscode: true },
    });
    const report = await engine.index(
      { config: { root }, session: null, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    expect(report).toMatchObject({ dryRun: true, consumers: [], target: null });
    expect(report.walk.filesIndexed).toBe(1);
    expect(log).toEqual([]);
  });
});

// U2b.1 part 3b (BMO-35, controller decision 20): CpgEngine.inspect(session, config), C-CLI's
// declared signature, reads the built-in memory store whole, as verify does.
const dirId = (path: string): string => makeNodeId({ form: 'directory', path: wp(path) });
const fileId = (path: string): string => makeNodeId({ form: 'file', path: wp(path) });
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: { id: string }, b: { id: string }): number => byCodeUnits(a.id, b.id);
const edgeKey = (e: { source: string; target: string; type?: string }): string =>
  `${e.source} ${e.type ?? ''} ${e.target}`;

describe('CpgEngine.inspect', () => {
  it('after index it returns what the memory store holds: DIRECTORY and FILE nodes, HAS_ENTRY', async () => {
    const root = await tree({ 'a.ts': '', 'src/b.py': '' });
    const engine = engineWith();
    const w = await engine.connect(TARGET, { readOnly: false });
    await engine.index(
      { config: { root }, session: w, resumeFrom: null },
      () => {},
      AbortSignal.timeout(60_000),
    );
    await w.close();
    const r = await engine.connect(TARGET, { readOnly: true });
    const payload = await engine.inspect(r, { root });
    await r.close();
    // merge-filesystem folds no delta, so the store is still at the fresh seq (C-SINK: -1)
    expect(payload.seq).toBe(-1);
    expect(payload.nodes.map((n) => `${n.type} ${n.id}`).toSorted(byCodeUnits)).toEqual(
      [
        `DIRECTORY ${dirId('.')}`,
        `DIRECTORY ${dirId('src')}`,
        `FILE ${fileId('a.ts')}`,
        `FILE ${fileId('src/b.py')}`,
      ].toSorted(byCodeUnits),
    );
    expect(payload.edges.map(edgeKey).toSorted(byCodeUnits)).toEqual(
      [
        `${dirId('.')} HAS_ENTRY ${fileId('a.ts')}`,
        `${dirId('.')} HAS_ENTRY ${dirId('src')}`,
        `${dirId('src')} HAS_ENTRY ${fileId('src/b.py')}`,
      ].toSorted(byCodeUnits),
    );
  });

  it('a planted memory store is returned whole, its seq included', async () => {
    const memory = createMemoryStore();
    const planted = {
      seq: 7,
      nodes: [
        { id: 'n1', type: 'FILE', name: 'a.ts', data: { path: 'a.ts' } },
        { id: 'n2', type: 'DIRECTORY' },
      ],
      edges: [{ source: 'n2', target: 'n1', type: 'HAS_ENTRY' }],
    };
    await memory.onSnapshot(planted, { seq: 7, cause: 'initial' });
    const engine = engineWith({ memory });
    const session = await engine.connect(TARGET, { readOnly: true });
    const payload = await engine.inspect(session, { root: '/w' });
    await session.close();
    expect({ ...payload, nodes: payload.nodes.toSorted(byId) }).toEqual(planted);
  });

  it('reads the built-in memory store, never a host sink', async () => {
    const memory = createMemoryStore();
    const host = recording('host');
    await memory.onSnapshot(
      { seq: 1, nodes: [{ id: 'mem', type: 'FILE' }], edges: [] },
      { seq: 1, cause: 'initial' },
    );
    await host.memory.onSnapshot(
      { seq: 2, nodes: [{ id: 'host', type: 'FILE' }], edges: [] },
      { seq: 2, cause: 'initial' },
    );
    const engine = engineWith({ memory, sinks: [host.sink] });
    const session = await engine.connect(TARGET, { readOnly: true });
    const payload = await engine.inspect(session, { root: '/w' });
    await session.close();
    expect(payload.nodes.map((n) => n.id)).toEqual(['mem']);
    expect(payload.seq).toBe(1);
  });

  it('the payload is a copy: changing it does not change what inspect returns next', async () => {
    const memory = createMemoryStore();
    await memory.onSnapshot(
      { seq: 0, nodes: [{ id: 'a', type: 'FILE' }], edges: [] },
      { seq: 0, cause: 'initial' },
    );
    const engine = engineWith({ memory });
    const session = await engine.connect(TARGET, { readOnly: true });
    const first = await engine.inspect(session, { root: '/w' });
    const [node] = first.nodes;
    if (node !== undefined) Reflect.set(node, 'id', 'changed');
    Reflect.set(first.nodes, 'length', 0);
    const second = await engine.inspect(session, { root: '/w' });
    await session.close();
    expect(second.nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('with the inspect switch on, connect opens the sinks and index writes memory', async () => {
    const root = await tree({ 'a.ts': '' });
    const engine = engineWith({ consumers: { inspect: true } });
    const session = await engine.connect(TARGET, { readOnly: false });
    const report = await engine.index(
      { config: { root }, session, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    await session.close();
    expect(report.consumers).toEqual(['memory']);
  });
});
