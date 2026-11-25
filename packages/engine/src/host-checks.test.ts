// The pure checks a host runs for itself (controller decision 25; C-EXT GraphHost.verify feeds them
// from its own payload and FilesystemProbe, 08-verification §3.1). Every input here is a plain object
// with ONLY the fields the check reads: a host has no WalkedFile, FileState or StaleNode to pass.
// Expected values come from 08-verification §3.1, C-CLI CheckResult, the C-EXT invariants and the
// doc comments, never from running the code. `engine.verify`'s own tests (verify.test.ts) pin the
// same semantics through the engine, unedited; the last group here pins that both agree.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_LABELS } from '@cpg/model';
import { createMemoryStore } from '@cpg/sink';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEngine,
  filesystemReconciliation,
  idUniqueness,
  revisionReconciliation,
  unavailableCheck,
  walkWorkspace,
  type AdmittedPath,
  type AdmittedRevision,
  type GraphFile,
  type GraphRevision,
} from './index';

const at = (path: string, parent: string): AdmittedPath => ({ path, parent });
const inGraph = (...files: readonly string[]): readonly GraphFile[] =>
  files.map((file) => ({ file }));
const rev = (path: string, revision_id: string): AdmittedRevision => ({ path, revision_id });
const grev = (file: string, revision_id: string): GraphRevision => ({ file, revision_id });

describe('filesystemReconciliation: admitted files vs the FILEs in the graph, per directory (C1)', () => {
  it('the same files in the same directories: pass, graph count over admitted count', () => {
    const r = filesystemReconciliation(
      [at('a.ts', '.'), at('src/b.py', 'src')],
      inGraph('a.ts', 'src/b.py'),
      7,
    );
    expect(r).toEqual({
      id: 'filesystem-reconciliation',
      state: 'pass',
      observed: 2,
      expected: 2,
      localisedTo: [],
      asOfSeq: 7,
    });
  });

  it('a file the graph lacks: fail, localised to its directory, not an ancestor', () => {
    const r = filesystemReconciliation(
      [at('a.ts', '.'), at('src/b.py', 'src'), at('src/deep/c.ts', 'src/deep')],
      inGraph('a.ts', 'src/b.py'),
      1,
    );
    expect(r).toMatchObject({
      id: 'filesystem-reconciliation',
      state: 'fail',
      observed: 2,
      expected: 3,
      localisedTo: ['src/deep'],
      asOfSeq: 1,
    });
    expect(r.detail).toBeDefined();
  });

  it('a FILE the disk lacks: fail, localised to the directory of that FILE (root is ".")', () => {
    expect(
      filesystemReconciliation([at('a.ts', '.')], inGraph('a.ts', 'old.ts', 'lib/x/y.ts'), 1),
    ).toMatchObject({ state: 'fail', observed: 3, expected: 1, localisedTo: ['.', 'lib/x'] });
  });

  it('the admitted side is compared with the parent it was given, not one re-derived from its path', () => {
    // Same path on both sides, but the host says it sits elsewhere: its directory is an offender.
    const r = filesystemReconciliation([at('src/b.py', 'other')], inGraph('src/b.py'), 1);
    expect(r).toMatchObject({ state: 'fail', localisedTo: ['other', 'src'] });
  });

  it('equal counts are not enough: one file swapped for another fails', () => {
    const r = filesystemReconciliation(
      [at('a.ts', '.'), at('src/z.py', 'src')],
      inGraph('a.ts', 'src/b.py'),
      1,
    );
    expect(r).toMatchObject({ state: 'fail', observed: 2, expected: 2, localisedTo: ['src'] });
  });

  it('a directory with no files left on disk is named; every offender once, in code-unit order', () => {
    const r = filesystemReconciliation(
      [at('aaa/n.ts', 'aaa'), at('aaa/o.ts', 'aaa'), at('Zed/q.ts', 'Zed')],
      inGraph('src/x.ts', 'src/y.ts', 'r.ts'),
      1,
    );
    expect(r).toMatchObject({
      state: 'fail',
      observed: 3,
      expected: 3,
      localisedTo: ['.', 'Zed', 'aaa', 'src'],
    });
  });

  it('nothing admitted and nothing in the graph: pass, 0 over 0', () => {
    expect(filesystemReconciliation([], [], -1)).toEqual({
      id: 'filesystem-reconciliation',
      state: 'pass',
      observed: 0,
      expected: 0,
      localisedTo: [],
      asOfSeq: -1,
    });
  });

  it('a FILE listed twice counts once: the repeat is id-uniqueness to report, not this check', () => {
    expect(filesystemReconciliation([at('a.ts', '.')], inGraph('a.ts', 'a.ts'), 1)).toMatchObject({
      state: 'pass',
      observed: 1,
      expected: 1,
    });
  });

  it('a path that is not workspace-relative is not dropped: it is an offender in its own directory', () => {
    expect(
      filesystemReconciliation([at('a.ts', '.')], inGraph('a.ts', '/abs/x.ts'), 1),
    ).toMatchObject({ state: 'fail', observed: 2, expected: 1, localisedTo: ['/abs'] });
  });
});

describe('idUniqueness: ids unique within each list (C3a)', () => {
  it('distinct ids: pass, ids over distinct ids', () => {
    expect(idUniqueness([['a', 'b']], 3)).toEqual({
      id: 'id-uniqueness',
      state: 'pass',
      observed: 2,
      expected: 2,
      localisedTo: [],
      asOfSeq: 3,
    });
  });

  it('repeats: fail, each repeated id once in code-unit order, the surplus visible in the counts', () => {
    // 6 ids, 3 distinct: 'b' twice, 'a' three times, 'Z' once
    const r = idUniqueness([['b', 'a', 'Z', 'a', 'b', 'a']], 2);
    expect(r).toMatchObject({
      id: 'id-uniqueness',
      state: 'fail',
      observed: 6,
      expected: 3,
      localisedTo: ['a', 'b'],
      asOfSeq: 2,
    });
    expect(r.detail).toBeDefined();
  });

  // Round two (review a2): a repeat inside two different lists is a repeat in each of them.
  it('repeats in two lists: counts add up, localisedTo is distinct across the lists', () => {
    // list 1: src twice (2 ids, 1 distinct); list 2: b twice and src twice (4 ids, 2 distinct)
    expect(
      idUniqueness(
        [
          ['src', 'src'],
          ['b', 'src', 'src', 'b'],
        ],
        1,
      ),
    ).toMatchObject({
      state: 'fail',
      observed: 6,
      expected: 3,
      localisedTo: ['b', 'src'],
    });
  });

  // Round two (review a3): code-unit order puts 'Z' before 'a'; localeCompare would not.
  it('localisedTo is in UTF-16 code-unit order', () => {
    expect(idUniqueness([['b', 'a', 'Z', 'a', 'b', 'a', 'Z']], 1)).toMatchObject({
      observed: 7,
      expected: 3,
      localisedTo: ['Z', 'a', 'b'],
    });
  });

  it('the same id in two lists is not a duplicate (labels never collide)', () => {
    expect(idUniqueness([['src'], ['src']], 1)).toMatchObject({
      state: 'pass',
      observed: 2,
      expected: 2,
      localisedTo: [],
    });
  });

  it("a host's one list of payload ids: a repeated payload id fails (C-EXT I-10)", () => {
    const ids = ['dir:.', 'file:a.ts', 'file:a.ts'];
    expect(idUniqueness([ids], 4)).toMatchObject({
      state: 'fail',
      observed: 3,
      expected: 2,
      localisedTo: ['file:a.ts'],
      asOfSeq: 4,
    });
  });

  it('no ids, or only empty lists: pass, 0 over 0', () => {
    for (const lists of [[], [[]], [[], []]] as const) {
      expect(idUniqueness(lists, 1)).toMatchObject({ state: 'pass', observed: 0, expected: 0 });
    }
  });
});

describe('revisionReconciliation: FILE revisions vs disk, and nodes vs their FILE (C4)', () => {
  it('every revision equal and no stale node: pass, 0 over 0', () => {
    expect(
      revisionReconciliation(
        [rev('a.ts', 'r1'), rev('src/b.py', 'r2')],
        [grev('a.ts', 'r1'), grev('src/b.py', 'r2')],
        [],
        5,
      ),
    ).toEqual({
      id: 'revision-reconciliation',
      state: 'pass',
      observed: 0,
      expected: 0,
      localisedTo: [],
      asOfSeq: 5,
    });
  });

  it("a FILE whose revision is not the disk's: fail, localised to the file", () => {
    const r = revisionReconciliation(
      [rev('a.ts', 'r1'), rev('src/b.py', 'r2')],
      [grev('a.ts', 'r1'), grev('src/b.py', 'old')],
      [],
      1,
    );
    expect(r).toMatchObject({
      id: 'revision-reconciliation',
      state: 'fail',
      observed: 1,
      expected: 0,
      localisedTo: ['src/b.py'],
      asOfSeq: 1,
    });
    expect(r.detail).toBeDefined();
  });

  it('a stale node: fail, localised to its file', () => {
    expect(
      revisionReconciliation([rev('a.ts', 'r1')], [grev('a.ts', 'r1')], [{ file: 'a.ts' }], 1),
    ).toMatchObject({ state: 'fail', observed: 1, localisedTo: ['a.ts'] });
  });

  it('every mismatch counts, each file once, in code-unit order (E4: only this check would fail)', () => {
    const r = revisionReconciliation(
      [rev('a.ts', 'r1'), rev('B.ts', 'r2'), rev('c.ts', 'r3')],
      [grev('a.ts', 'r1'), grev('B.ts', 'old'), grev('c.ts', 'old')],
      [{ file: 'c.ts' }, { file: 'a.ts' }, { file: 'a.ts' }],
      1,
    );
    expect(r).toMatchObject({
      state: 'fail',
      observed: 5,
      expected: 0,
      localisedTo: ['B.ts', 'a.ts', 'c.ts'],
    });
  });

  // Round two (review a6): a FILE listed twice is compared twice; a later match hides nothing.
  it('a FILE listed twice: its earlier mismatch still counts', () => {
    expect(
      revisionReconciliation([rev('a.ts', 'r1')], [grev('a.ts', 'old'), grev('a.ts', 'r1')], [], 1),
    ).toMatchObject({ state: 'fail', observed: 1, localisedTo: ['a.ts'] });
  });

  // Round two (review a7): a stale node counts even when its file is not among the admitted ones.
  it('a stale node in a file the disk side left out: fail, localised to its file', () => {
    expect(
      revisionReconciliation(
        [rev('a.ts', 'r1')],
        [grev('a.ts', 'r1'), grev('b.ts', 'r2')],
        [{ file: 'b.ts' }],
        1,
      ),
    ).toMatchObject({ state: 'fail', observed: 1, localisedTo: ['b.ts'] });
  });

  it('a graph FILE not on disk, and a disk file not in the graph, are left to another check', () => {
    expect(
      revisionReconciliation([rev('new.ts', 'r9')], [grev('gone.ts', 'old')], [], 1),
    ).toMatchObject({ state: 'pass', observed: 0, localisedTo: [] });
  });

  it('an admitted file with no digest is left out of the admitted list, so it is not a mismatch', () => {
    // FilesystemProbe.digest is undefined for a file that cannot be read: the host omits it.
    expect(
      revisionReconciliation([rev('a.ts', 'r1')], [grev('a.ts', 'r1'), grev('b.ts', 'r2')], [], 1),
    ).toMatchObject({ state: 'pass', observed: 0 });
  });
});

describe('unavailableCheck', () => {
  it('is unavailable, 0 over 0, with no localisation, the reason in detail', () => {
    expect(unavailableCheck('identity-invariants', 9, 'no code tier yet')).toEqual({
      id: 'identity-invariants',
      state: 'unavailable',
      observed: 0,
      expected: 0,
      localisedTo: [],
      detail: 'no code tier yet',
      asOfSeq: 9,
    });
  });

  it.each([
    'filesystem-reconciliation',
    'id-uniqueness',
    'render-reconciliation',
    'revision-reconciliation',
    'resolution-health',
  ] as const)('%s keeps its own id', (id) => {
    expect(unavailableCheck(id, -1, 'x')).toMatchObject({ id, asOfSeq: -1, detail: 'x' });
  });
});

// Two definitions of one verdict would drift (decision 25's options weighed): the exported checks,
// fed with what a host would read, must give exactly the rows engine.verify gives for the same graph.
describe('the exported checks agree with engine.verify', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  const TARGET = { host: 'localhost', port: 6382, graph: 'cpg' };

  /** A workspace with a.ts and src/b.py, indexed into `memory`. */
  async function indexedWorkspace() {
    const root = await mkdtemp(join(tmpdir(), 'cpg-host-checks-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'src', 'b.py'), 'b = 2\n');
    const memory = createMemoryStore();
    const engine = createEngine(
      { version: '0', consumers: { inspect: false, store: 'memory', vscode: false } },
      { memoryStore: memory },
    );
    const session = await engine.connect(TARGET, { readOnly: false });
    await engine.index(
      { config: { root }, session, resumeFrom: null },
      () => {},
      new AbortController().signal,
    );
    await session.close();
    return { root, memory, engine };
  }

  // Everything is read inside one read session: the memory store answers only while it is open.
  async function rowsAndReads(
    { root, memory, engine }: Awaited<ReturnType<typeof indexedWorkspace>>,
    plant?: () => Promise<void>,
  ) {
    const session = await engine.connect(TARGET, { readOnly: true });
    try {
      if (plant !== undefined) await plant();
      const report = await engine.verify(session, { root }, null);
      const seq = (await memory.inspect()).highWaterSeq;
      return {
        seq,
        row: (id: string) => report.checks.find((c) => c.id === id),
        states: await memory.fileStates(),
        keyLists: await Promise.all(NODE_LABELS.map((spec) => memory.nodeKeys(spec.label))),
        stale: await memory.staleNodes(),
      };
    } finally {
      await session.close();
    }
  }

  // Round two (review a1): the id-uniqueness row agrees too, on a graph that really fails it.
  it('a planted duplicate id: the id-uniqueness row equals the engine row and fails', async () => {
    const ws = await indexedWorkspace();
    const { seq, row, keyLists } = await rowsAndReads(ws, async () => {
      const graph = await ws.memory.readAll();
      const twin = graph.nodes.find((n) => n.type === 'FILE');
      if (twin === undefined) throw new Error('no FILE node to repeat');
      const plantedSeq = graph.seq + 1;
      await ws.memory.onSnapshot(
        { ...graph, seq: plantedSeq, nodes: [...graph.nodes, twin] },
        { seq: plantedSeq, cause: 'initial' },
      );
    });
    expect(row('id-uniqueness')?.state).toBe('fail');
    expect(idUniqueness(keyLists, seq)).toEqual(row('id-uniqueness'));
  });

  it('a missing file, a changed file and an extra file: every row equals the engine row', async () => {
    const ws = await indexedWorkspace();
    const { root } = ws;
    await writeFile(join(root, 'src', 'b.py'), 'b = 3\n');
    await rm(join(root, 'a.ts'));
    await writeFile(join(root, 'new.ts'), 'export const n = 1;\n');
    const { seq, row, states, keyLists, stale } = await rowsAndReads(ws);
    const walk = await walkWorkspace({ root, languageOf: () => undefined });

    expect(filesystemReconciliation(walk.files, states, seq)).toEqual(
      row('filesystem-reconciliation'),
    );
    expect(idUniqueness(keyLists, seq)).toEqual(row('id-uniqueness'));
    expect(revisionReconciliation(walk.files, states, stale, seq)).toEqual(
      row('revision-reconciliation'),
    );
    // Not vacuous: the planted faults are really in the rows.
    expect(row('filesystem-reconciliation')?.state).toBe('fail');
    expect(row('revision-reconciliation')?.state).toBe('fail');
    expect(
      unavailableCheck('identity-invariants', seq, row('identity-invariants')?.detail ?? ''),
    ).toEqual(row('identity-invariants'));
    expect(
      unavailableCheck('resolution-health', seq, row('resolution-health')?.detail ?? ''),
    ).toEqual(row('resolution-health'));
  });
});
