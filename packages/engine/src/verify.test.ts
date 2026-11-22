// engine.verify, from BMO-80's acceptance list, C-CLI (CheckResult, VerifyReport, I-21, Q9), the
// shared verify_check_ids / verify_check_states enums (05-contracts.yaml) and 08-verification.md §3.
// Workspaces are temp trees; planted graphs are hand-built payloads; revision ids are an
// independent sha256 of the bytes.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isWorkspacePath,
  makeNodeId,
  NODE_LABELS,
  type GraphNode,
  type NodeLabel,
  type WorkspacePath,
} from '@cpg/model';
import { createMemoryStore } from '@cpg/sink';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDES } from './walker/defaults';
import type { EngineSink } from './engine';
import { createEngine } from './engine';
import type {
  CheckResult,
  CheckState,
  ConsumerSwitches,
  CpgEngine,
  StoreTarget,
  VerifyCheckId,
  VerifyConfig,
  VerifyReport,
} from './port';
import { worstState } from './verify';

const IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];
const TARGET: StoreTarget = { host: 'localhost', port: 6382, graph: 'cpg' };
/** The CLI's switches: memory only, no renderer (owner decision 5a builds the sinks from these). */
const HEADLESS: ConsumerSwitches = { inspect: false, store: 'memory', vscode: false };
/** An engine whose built-in memory store is `memory` (a test plants graphs in it). */
const engineOn = (memory: EngineSink, sinks: readonly EngineSink[] = []): CpgEngine =>
  createEngine({ version: '0', consumers: HEADLESS }, { memoryStore: memory, sinks });
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function put(root: string, spec: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(spec)) {
    const abs = join(root, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
}

async function tree(spec: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-verify-'));
  roots.push(root);
  await put(root, spec);
  return root;
}

// Admitted: a.ts, notes.txt (no language, still a FILE), src/b.py, src/deep/c.ts. Excluded by
// default: node_modules/**. So 4 FILE nodes and 3 DIRECTORY nodes ('.', 'src', 'src/deep').
const FILES = {
  'a.ts': 'export const a = 1;\n',
  'notes.txt': 'notes\n',
  'src/b.py': 'b = 2\n',
  'src/deep/c.ts': 'export const c = 3;\n',
  'node_modules/x/index.js': 'module.exports = 1;\n',
};

async function indexInto(
  engine: CpgEngine,
  root: string,
  config: Omit<VerifyConfig, 'root'> = {},
): Promise<void> {
  const session = await engine.connect(TARGET, { readOnly: false });
  try {
    await engine.index(
      { config: { root, ...config }, session, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
  } finally {
    await session.close();
  }
}

async function verify(
  engine: CpgEngine,
  root: string,
  config: Omit<VerifyConfig, 'root'> = {},
): Promise<VerifyReport> {
  const session = await engine.connect(TARGET, { readOnly: true });
  try {
    return await engine.verify(session, { root, ...config }, null);
  } finally {
    await session.close();
  }
}

/** A real index of `files`, then the engine (same MemoryStore) to verify with. */
async function indexed(files: Readonly<Record<string, string>> = FILES, id = 'memory') {
  const root = await tree(files);
  const memory = createMemoryStore({ id });
  const engine = engineOn(memory);
  await indexInto(engine, root);
  return { root, memory, engine };
}

function check(report: VerifyReport, id: VerifyCheckId): CheckResult {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no ${id} in the report`);
  return found;
}
const states = (report: VerifyReport): Record<string, CheckState> =>
  Object.fromEntries(report.checks.map((c) => [c.id, c.state]));

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const dir = (path: string): GraphNode => ({
  id: makeNodeId({ form: 'directory', path: wp(path) }),
  type: 'DIRECTORY',
  name: path,
  data: { path, name: path, status: 'ready' },
});
const file = (path: string, text: string): GraphNode => ({
  id: makeNodeId({ form: 'file', path: wp(path) }),
  type: 'FILE',
  name: path,
  data: { path, name: path, revision_id: sha256(text) },
});

const moduleNode = (id: string): GraphNode => ({ id, type: 'MODULE', data: {} });
/** A code-tier node owned by `owner`, carrying the revision it was derived from. */
const owned = (owner: string, id: string, revision_id: string): GraphNode => ({
  id,
  type: 'MODULE',
  data: { file: owner, revision_id },
});

/** A hand-built graph planted in a MemoryStore as a snapshot at `seq`. */
async function planted(files: Readonly<Record<string, string>>, nodes: GraphNode[], seq = 4) {
  const root = await tree(files);
  const memory = createMemoryStore();
  await memory.onSnapshot({ seq, nodes, edges: [] }, { seq, cause: 'initial' });
  const engine = engineOn(memory);
  return { root, engine };
}

describe('worstState: fail > stale > unavailable > pass', () => {
  const ORDER: readonly CheckState[] = ['pass', 'unavailable', 'stale', 'fail'];

  it('no states is pass; one state is itself', () => {
    expect(worstState([])).toBe('pass');
    for (const s of ORDER) expect(worstState([s])).toBe(s);
  });

  it('every pair, either order, gives the higher-ranked state', () => {
    for (const [i, a] of ORDER.entries())
      for (const [j, b] of ORDER.entries()) {
        const want = ORDER[Math.max(i, j)];
        expect([worstState([a, b]), worstState([b, a])]).toEqual([want, want]);
      }
  });

  it.each([
    [['pass', 'unavailable', 'pass'], 'unavailable'],
    [['unavailable', 'pass', 'stale', 'pass'], 'stale'],
    [['pass', 'stale', 'unavailable', 'fail', 'pass'], 'fail'],
  ] as const)('%j -> %s', (input, want) => {
    expect(worstState(input)).toBe(want);
  });
});

describe('VerifyReport (I-21)', () => {
  it('a freshly indexed workspace: three checks pass, three are unavailable until their units', async () => {
    const { root, engine } = await indexed(FILES, 'mem-a');
    const report = await verify(engine, root);

    expect(report.checks.map((c) => c.id)).toEqual(IDS);
    expect(report.checks).toMatchObject([
      { state: 'pass', observed: 4, expected: 4, localisedTo: [] },
      { state: 'unavailable', localisedTo: [] },
      { state: 'pass', observed: 7, expected: 7, localisedTo: [] },
      { state: 'unavailable', localisedTo: [] },
      { state: 'pass', observed: 0, expected: 0, localisedTo: [] },
      { state: 'unavailable', localisedTo: [] },
    ]);
    // merge-filesystem carries no seq, so the sink is still at -1 ("-1 for a fresh sink").
    for (const c of report.checks) expect(c.asOfSeq).toBe(-1);
    expect(report.state).toBe('unavailable');
    expect(report.consumers).toEqual(['mem-a']);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('--strict (config.strict) promotes every unavailable check to fail; pass stays pass', async () => {
    const { root, engine } = await indexed();
    const report = await verify(engine, root, { strict: true });
    expect(states(report)).toEqual({
      'filesystem-reconciliation': 'pass',
      'identity-invariants': 'fail',
      'id-uniqueness': 'pass',
      'render-reconciliation': 'fail',
      'revision-reconciliation': 'pass',
      'resolution-health': 'fail',
    });
    expect(report.state).toBe('fail');
  });

  it('headless (no renderer consumer): render-reconciliation is unavailable and says why (ND-8)', async () => {
    const { root, engine } = await indexed();
    const report = await verify(engine, root);
    expect(check(report, 'render-reconciliation')).toMatchObject({
      state: 'unavailable',
      observed: 0,
      expected: 0,
      localisedTo: [],
    });
    expect(check(report, 'render-reconciliation').detail).toMatch(/no renderer consumer/);
  });

  it("the engine's own memory store: verify reads what index wrote, with no store passed in", async () => {
    const root = await tree(FILES);
    const engine = createEngine({ version: '0', consumers: HEADLESS });
    await indexInto(engine, root);
    const report = await verify(engine, root);
    expect(check(report, 'filesystem-reconciliation')).toMatchObject({
      state: 'pass',
      observed: 4,
      expected: 4,
    });
    expect(report.consumers).toEqual(['memory']);
  });

  it("a fresh engine has a fresh store: another engine's index is not seen", async () => {
    const root = await tree(FILES);
    await indexInto(createEngine({ version: '0', consumers: HEADLESS }), root);
    const report = await verify(createEngine({ version: '0', consumers: HEADLESS }), root);
    expect(check(report, 'filesystem-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 0,
      expected: 4,
    });
  });

  it('asOfSeq is read once, before any store read, even while a writer moves the seq', async () => {
    const ws = { 'a.ts': 'export const a = 1;\n' };
    const nodes = [dir('.'), file('a.ts', ws['a.ts'])];
    const root = await tree(ws);
    const memory = createMemoryStore();
    await memory.onSnapshot({ seq: 4, nodes, edges: [] }, { seq: 4, cause: 'initial' });
    const calls: string[] = [];
    let seq = 4;
    // A concurrent writer: every store read lands one more snapshot of the same graph.
    async function moved(name: string): Promise<void> {
      calls.push(name);
      seq += 1;
      await memory.onSnapshot({ seq, nodes, edges: [] }, { seq, cause: 'catch-up' });
    }
    const sink: EngineSink = {
      ...memory,
      async inspect() {
        calls.push('inspect');
        return memory.inspect();
      },
      async fileStates() {
        await moved('fileStates');
        return memory.fileStates();
      },
      async nodeKeys(label) {
        await moved('nodeKeys');
        return memory.nodeKeys(label);
      },
      async staleNodes() {
        await moved('staleNodes');
        return memory.staleNodes();
      },
    };
    const report = await verify(engineOn(sink), root);
    for (const c of report.checks) expect(c.asOfSeq).toBe(4);
    expect(calls[0]).toBe('inspect');
    expect(calls.filter((c) => c === 'inspect')).toHaveLength(1);
    expect(calls).toContain('staleNodes');
  });
});

describe('filesystem-reconciliation: admitted files vs FILE nodes, per directory', () => {
  it('a file added after index fails, localised to its own directory, not an ancestor', async () => {
    const { root, engine } = await indexed();
    await put(root, { 'src/deep/new.ts': 'export const n = 0;\n' });
    const report = await verify(engine, root);
    expect(check(report, 'filesystem-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 4,
      expected: 5,
      localisedTo: ['src/deep'],
    });
    expect(check(report, 'revision-reconciliation').state).toBe('pass');
    expect(check(report, 'id-uniqueness').state).toBe('pass');
    expect(report.state).toBe('fail');
  });

  it('a file deleted after index fails here, not in revision-reconciliation', async () => {
    const { root, engine } = await indexed();
    await rm(join(root, 'a.ts'));
    const report = await verify(engine, root);
    expect(check(report, 'filesystem-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 4,
      expected: 3,
      localisedTo: ['.'],
    });
    expect(check(report, 'revision-reconciliation')).toMatchObject({ state: 'pass', observed: 0 });
  });

  it('a dropped subtree names every directory that lost files', async () => {
    const { root, engine } = await indexed();
    await rm(join(root, 'src'), { recursive: true });
    const report = await verify(engine, root);
    expect(check(report, 'filesystem-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 4,
      expected: 2,
      localisedTo: ['src', 'src/deep'],
    });
  });

  it('equal counts are not enough: one file swapped for another fails', async () => {
    const { root, engine } = await indexed();
    await rm(join(root, 'src', 'b.py'));
    await put(root, { 'src/z.py': 'z = 26\n' });
    const report = await verify(engine, root);
    expect(check(report, 'filesystem-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 4,
      expected: 4,
      localisedTo: ['src'],
    });
  });

  it('offending directories are listed once each, in code-unit order', async () => {
    const { root, engine } = await indexed();
    await rm(join(root, 'a.ts'));
    await put(root, { 'src/x.ts': 'x\n', 'src/y.ts': 'y\n', 'aaa/n.ts': 'n\n', 'Zed/q.ts': 'q\n' });
    const report = await verify(engine, root);
    expect(check(report, 'filesystem-reconciliation').localisedTo).toEqual([
      '.',
      'Zed',
      'aaa',
      'src',
    ]);
  });

  it("verify walks with the config's scope: include, exclude and maxFileSizeBytes reach its walk", async () => {
    // Each option alone removes one file: include drops r.py, exclude drops notes.txt (which
    // include admits), maxFileSizeBytes drops src/big.py. Only src/b.py (6 bytes) survives all three.
    const root = await tree({
      'r.py': 'r = 1\n',
      'notes.txt': 'notes\n',
      'src/b.py': 'b = 2\n',
      'src/big.py': 'big = 1234567890\n',
    });
    const engine = engineOn(createMemoryStore());
    const include = ['src/**', '**/*.txt'];
    const exclude = [...DEFAULT_EXCLUDES, '**/*.txt'];
    const maxFileSizeBytes = 10;
    const scope = { include, exclude, maxFileSizeBytes };
    await indexInto(engine, root, scope);
    expect(check(await verify(engine, root, scope), 'filesystem-reconciliation')).toMatchObject({
      state: 'pass',
      observed: 1,
      expected: 1,
    });
    for (const partial of [
      { exclude, maxFileSizeBytes },
      { include, maxFileSizeBytes },
      { include, exclude },
    ])
      expect(check(await verify(engine, root, partial), 'filesystem-reconciliation')).toMatchObject(
        { state: 'fail', expected: 2 },
      );
  });
});

describe('id-uniqueness via store.nodeKeys', () => {
  const ws = { 'a.ts': 'export const a = 1;\n', 'src/b.py': 'b = 2\n' };

  it('a planted duplicate id fails id-uniqueness alone, localised to the duplicate', async () => {
    const nodes = [
      dir('.'),
      dir('src'),
      file('a.ts', ws['a.ts']),
      file('src/b.py', ws['src/b.py']),
      file('src/b.py', ws['src/b.py']),
    ];
    const { root, engine } = await planted(ws, nodes, 4);
    const report = await verify(engine, root);
    expect(check(report, 'id-uniqueness')).toMatchObject({
      state: 'fail',
      observed: 5,
      expected: 4,
      localisedTo: ['src/b.py'],
    });
    expect(check(report, 'filesystem-reconciliation')).toMatchObject({
      state: 'pass',
      observed: 2,
      expected: 2,
    });
    expect(check(report, 'revision-reconciliation').state).toBe('pass');
    expect(report.state).toBe('fail');
    for (const c of report.checks) expect(c.asOfSeq).toBe(4);
  });

  it('every schema label is read through nodeKeys; each duplicated key is listed once, in code-unit order; keys of different labels never collide', async () => {
    const meta: GraphNode = { id: 'meta', type: 'META_DATA', data: {} };
    const nodes = [
      dir('.'),
      dir('src'),
      file('a.ts', ws['a.ts']),
      file('a.ts', ws['a.ts']),
      file('a.ts', ws['a.ts']),
      file('src/b.py', ws['src/b.py']),
      moduleNode('Zm'),
      moduleNode('Zm'),
      // the string 'src' is also DIRECTORY src's key, but its id is dir:src: not a duplicate
      moduleNode('src'),
      // META_DATA is the last schema label
      meta,
      meta,
    ];
    const root = await tree(ws);
    const memory = createMemoryStore();
    await memory.onSnapshot({ seq: 0, nodes, edges: [] }, { seq: 0, cause: 'initial' });
    const labels: NodeLabel[] = [];
    const sink: EngineSink = {
      ...memory,
      nodeKeys(label) {
        labels.push(label);
        return memory.nodeKeys(label);
      },
    };
    const report = await verify(engineOn(sink), root);
    // Keys: DIRECTORY 2 (2 distinct), FILE 4 (2), MODULE 3 (2), META_DATA 2 (1).
    expect(check(report, 'id-uniqueness')).toMatchObject({
      state: 'fail',
      observed: 11,
      expected: 7,
      localisedTo: ['Zm', 'a.ts', 'meta'],
    });
    expect(new Set(labels)).toEqual(new Set(NODE_LABELS.map((l) => l.label)));
  });
});

describe('revision-reconciliation via store.staleNodes() and sha256 on disk', () => {
  it('a file edited after index fails revision-reconciliation alone, localised to the file', async () => {
    const { root, engine } = await indexed();
    await put(root, { 'src/b.py': 'b = 3\n' });
    const report = await verify(engine, root);
    expect(check(report, 'revision-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 1,
      expected: 0,
      localisedTo: ['src/b.py'],
    });
    expect(check(report, 'filesystem-reconciliation').state).toBe('pass');
    expect(check(report, 'id-uniqueness').state).toBe('pass');
    expect(report.state).toBe('fail');
  });

  it('a :CPG node whose revision_id differs from its FILE (staleNodes) fails alone, localised to its file', async () => {
    const ws = { 'a.ts': 'export const a = 1;\n' };
    const nodes = [
      dir('.'),
      file('a.ts', ws['a.ts']),
      owned('a.ts', 'mod:a1', 'an-older-revision'),
      owned('a.ts', 'mod:a2', sha256(ws['a.ts'])),
    ];
    const { root, engine } = await planted(ws, nodes);
    expect(check(await verify(engine, root), 'revision-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 1,
      expected: 0,
      localisedTo: ['a.ts'],
    });
  });

  it('both sources together: every mismatch counts, each file is listed once, in code-unit order', async () => {
    const ws = { 'a.ts': 'export const a = 1;\n', 'B.ts': 'export const B = 2;\n', 'c.ts': 'c\n' };
    const nodes = [
      dir('.'),
      file('a.ts', ws['a.ts']),
      // B.ts and c.ts were indexed from older bytes
      file('B.ts', 'export const B = 1;\n'),
      file('c.ts', 'old c\n'),
      // stale against their FILE; by id, c.ts's row comes before a.ts's
      owned('c.ts', 'mod:1', 'an-older-revision'),
      owned('a.ts', 'mod:2', 'an-older-revision'),
    ];
    const { root, engine } = await planted(ws, nodes);
    expect(check(await verify(engine, root), 'revision-reconciliation')).toMatchObject({
      state: 'fail',
      observed: 4,
      expected: 0,
      localisedTo: ['B.ts', 'a.ts', 'c.ts'],
    });
  });
});

describe('verify is a read', () => {
  it('writes nothing, so a failing graph still fails the second time', async () => {
    const root = await tree(FILES);
    const memory = createMemoryStore();
    const writes: string[] = [];
    const sink: EngineSink = {
      ...memory,
      write(op) {
        writes.push(op.kind);
        return memory.write(op);
      },
      onDelta(delta, meta) {
        writes.push('delta');
        return memory.onDelta(delta, meta);
      },
      onSnapshot(payload, meta) {
        writes.push('snapshot');
        return memory.onSnapshot(payload, meta);
      },
    };
    const engine = engineOn(sink);
    await indexInto(engine, root);
    writes.length = 0;
    await put(root, { 'a.ts': 'export const a = 2;\n' });

    const first = await verify(engine, root);
    const second = await verify(engine, root);
    expect(check(first, 'revision-reconciliation').state).toBe('fail');
    expect(check(second, 'revision-reconciliation').state).toBe('fail');
    expect(writes).toEqual([]);
  });

  it('a non-null expected IndexReport is a SEAT until its first caller (C-CLI Q9)', async () => {
    const { root, engine } = await indexed();
    const session = await engine.connect(TARGET, { readOnly: true });
    const expected = await engine.index(
      { config: { root }, session: null, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    await expect(engine.verify(session, { root }, expected)).rejects.toThrow(/SEAT.*expected/);
    await session.close();
  });

  it('a host sink is not read: verify reads the built-in store, and lists only it', async () => {
    const root = await tree(FILES);
    const host = createMemoryStore({ id: 'host' });
    const engine = engineOn(createMemoryStore({ id: 'built-in' }), [host]);
    await indexInto(engine, root);
    // A duplicated id planted in the host sink alone: the built-in store still holds one of each.
    const nodes = [dir('.'), file('a.ts', FILES['a.ts']), moduleNode('m'), moduleNode('m')];
    await host.onSnapshot({ seq: 9, nodes, edges: [] }, { seq: 9, cause: 'initial' });
    const report = await verify(engine, root);
    expect(check(report, 'id-uniqueness').state).toBe('pass');
    expect(check(report, 'filesystem-reconciliation').state).toBe('pass');
    expect(report.consumers).toEqual(['built-in']);
  });
});
