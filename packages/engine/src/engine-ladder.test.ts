// The engine's merge-filesystem op against the ladder: every rung's [filesystem] section is the
// expected DIRECTORY/FILE/HAS_ENTRY of its ws/ (hand-written from the source, never captured from
// cpg). The rows carry keys, so each row's id is rebuilt with makeNodeId and compared to the fact.

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

function facts(rung: string): string[][] {
  const out: string[][] = [];
  let inSection = false;
  for (const raw of readFileSync(join(LADDER, rung, 'expected.cpg'), 'utf8').split('\n')) {
    const text = raw.replace(/(^|\s)#.*$/, '').trim();
    if (text === '') continue;
    const header = /^\[(\w+)\]$/.exec(text)?.[1];
    if (header !== undefined) inSection = header === 'filesystem';
    else if (inSection) out.push(text.split(/\s+/));
  }
  return out;
}

function idOf(label: string, key: string): string {
  if (!isWorkspacePath(key)) throw new Error(`not a WorkspacePath: ${key}`);
  return makeNodeId({ form: label === 'DIRECTORY' ? 'directory' : 'file', path: key });
}

// No return annotation: inference narrows to the merge-filesystem arm, and an annotation naming
// WriteOp lints as an error type when lint runs before the build (CI).
async function opFor(root: string) {
  const memory = createMemoryStore();
  const ops: WriteOp[] = [];
  const sink = {
    ...memory,
    write(op: WriteOp) {
      ops.push(op);
      return memory.write(op);
    },
  };
  const engine = createEngine({ version: '0' }, { sinks: [sink] });
  const session = await engine.connect({ host: 'h', port: 1, graph: 'g' }, { readOnly: false });
  await engine.index(
    { config: { root }, session, resumeFrom: null },
    () => {},
    new AbortController().signal,
  );
  await session.close();
  const [op, ...rest] = ops;
  if (op?.kind !== 'merge-filesystem' || rest.length > 0)
    throw new Error('expected ONE merge-filesystem op');
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
