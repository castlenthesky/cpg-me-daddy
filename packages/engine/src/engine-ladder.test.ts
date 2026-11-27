// The engine's merge-filesystem op against the ladder: every rung's [filesystem] section is the
// expected DIRECTORY/FILE/HAS_ENTRY of its ws/ (hand-written from the source, never captured from
// cpg). The rows carry keys, so each row's id is rebuilt with makeNodeId and compared to the fact.
// U6a.3-2: the replace-file ops after it carry the MODULE tier of every python file, checked against
// the MODULE, SOURCE_FILE and module DEFINES lines of [structural] and [symbols].

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWorkspacePath, makeNodeId } from '@cpg/model';
import { createMemoryStore } from '@cpg/sink';
import type { NodeRow, WriteOp } from '@cpg/store';
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';

const LADDER = join(__dirname, '../../../fixtures/ladder');
const RUNGS = readdirSync(LADDER, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

function facts(rung: string, sections: readonly string[] = ['filesystem']): string[][] {
  const out: string[][] = [];
  let inSection = false;
  for (const raw of readFileSync(join(LADDER, rung, 'expected.cpg'), 'utf8').split('\n')) {
    const text = raw.replace(/(^|\s)#.*$/, '').trim();
    if (text === '') continue;
    const header = /^\[(\w+)\]$/.exec(text)?.[1];
    if (header !== undefined) inSection = sections.includes(header);
    else if (inSection) out.push(text.split(/\s+/));
  }
  return out;
}

function idOf(label: string, key: string): string {
  if (!isWorkspacePath(key)) throw new Error(`not a WorkspacePath: ${key}`);
  return makeNodeId({ form: label === 'DIRECTORY' ? 'directory' : 'file', path: key });
}

async function opsFor(root: string): Promise<WriteOp[]> {
  const memory = createMemoryStore();
  const ops: WriteOp[] = [];
  const sink = {
    ...memory,
    write(op: WriteOp) {
      ops.push(op);
      return memory.write(op);
    },
  };
  const engine = createEngine(
    { version: '0', consumers: { inspect: false, store: 'memory', vscode: false } },
    { memoryStore: sink },
  );
  const session = await engine.connect({ host: 'h', port: 1, graph: 'g' }, { readOnly: false });
  await engine.index(
    { config: { root }, session, resumeFrom: null },
    () => {},
    new AbortController().signal,
  );
  await session.close();
  return ops;
}

// No return annotation: inference narrows to the merge-filesystem arm, and an annotation naming
// WriteOp lints as an error type when lint runs before the build (CI).
async function opFor(root: string) {
  const [op, ...rest] = await opsFor(root);
  if (op?.kind !== 'merge-filesystem' || rest.some((o) => o.kind !== 'replace-file'))
    throw new Error('expected ONE merge-filesystem op, then replace-file ops only');
  return op;
}

describe('the engine writes every ladder rung [filesystem] section as one merge-filesystem op', () => {
  it('finds all 13 rungs', () => {
    expect(RUNGS).toHaveLength(13);
  });

  it.each(RUNGS)('%s', async (rung) => {
    const op = await opFor(join(LADDER, rung, 'ws'));
    const all = facts(rung);
    const problems: string[] = [];

    const rows = new Map<string, NodeRow>();
    for (const row of [...op.directories, ...op.files]) {
      const id = idOf(row.label, row.key);
      if (rows.has(id)) problems.push(`duplicate row ${id}`);
      rows.set(id, row);
    }
    const nodeFacts = all.filter((f) => f[2] !== '->');
    const want = new Set(nodeFacts.map((f) => f[1]));
    for (const id of rows.keys()) if (!want.has(id)) problems.push(`extra row ${id}`);
    for (const [label = '', id = '', ...props] of nodeFacts) {
      const row = rows.get(id);
      if (row === undefined) {
        problems.push(`missing row ${id}`);
        continue;
      }
      if (row.label !== label) problems.push(`${id} label ${row.label}, want ${label}`);
      for (const prop of props) {
        const [key = '', value = ''] = prop.split('=');
        const got = row.properties[key] ?? null; // null is the absent value
        if (got !== (value === 'null' ? null : value))
          problems.push(`${id} ${key}=${JSON.stringify(got)}, want ${value}`);
      }
    }

    const links = op.links.map(
      (l) => `${l.type} ${idOf(l.fromLabel, l.fromKey)} -> ${idOf(l.toLabel, l.toKey)}`,
    );
    const wantLinks = all
      .filter((f) => f[2] === '->')
      .map(([t, from, , to]) => `${t} ${from} -> ${to}`);
    expect(links.toSorted()).toEqual(wantLinks.toSorted());
    expect(problems).toEqual([]);
  });
});

// U6a.3-2 (decisions 96, 101; C-EXTRACT Q8): the code tier is the MODULE tier until Pass A (U6a.2-3),
// so of [structural] and [symbols] only the lines about a python file's MODULE apply: the MODULE with
// its name and range, its SOURCE_FILE to the FILE, and its DEFINES to the module SYMBOL. A TS file has
// no extractor yet, so it has no replace-file at all.
const fileOfModule = (id: string): string => id.slice(0, id.indexOf(':MODULE:'));

function moduleFacts(rung: string): string[] {
  const python = new Set(
    facts(rung)
      .filter(([label, , ...props]) => label === 'FILE' && props.includes('language=python'))
      .map(([, id]) => id),
  );
  const isPythonModule = (id = ''): boolean =>
    id.includes(':MODULE:') && python.has(fileOfModule(id));
  return facts(rung, ['structural', 'symbols'])
    .filter(([label, id, arrow]) =>
      label === 'MODULE'
        ? isPythonModule(id)
        : (label === 'SOURCE_FILE' || label === 'DEFINES') && arrow === '->' && isPythonModule(id),
    )
    .map((f) => f.join(' '));
}

function moduleLines(ops: readonly WriteOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind !== 'replace-file') continue;
    for (const row of op.nodes.filter((n) => n.label === 'MODULE')) {
      const { name, range } = row.properties;
      out.push(`MODULE ${row.key} name=${String(name)} range=${String(range)}`);
    }
    for (const e of op.edges) {
      if (e.fromLabel !== 'MODULE') continue;
      if (e.type === 'SOURCE_FILE')
        out.push(`SOURCE_FILE ${e.fromKey} -> ${idOf('FILE', e.toKey)}`);
      if (e.type === 'DEFINES') out.push(`DEFINES ${e.fromKey} -> ${e.toKey}`);
    }
  }
  return out;
}

describe('the engine writes the MODULE tier of every python file in the ladder (U6a.3-2)', () => {
  it('the python rungs hold MODULE facts to check (anti-vacuity)', () => {
    const counts = RUNGS.map((rung) => moduleFacts(rung).length);
    // rungs 01-09 are python (07 has three files, 06 two); 00 is text and 10-12 are TS
    expect(counts.filter((n) => n > 0)).toHaveLength(9);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3 * 12);
  });

  it.each(RUNGS)('%s', async (rung) => {
    const ops = await opsFor(join(LADDER, rung, 'ws'));
    expect(moduleLines(ops).toSorted()).toEqual(moduleFacts(rung).toSorted());
  });
});
