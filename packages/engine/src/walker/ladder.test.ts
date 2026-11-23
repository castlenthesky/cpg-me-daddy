// The walker's goldens are the ladder: every rung's [filesystem] section is the expected tier of its
// ws/ directory (hand-written from the source, never captured from cpg). A line asserts its id, its
// label and exactly the properties it lists; the node and edge SETS must match exactly.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_LANGUAGES, createLanguageRegistry } from '@cpg/parse';
import { describe, expect, it } from 'vitest';
import { filesystemTier } from './filesystem-tier';
import { walkWorkspace } from './walker';

const LADDER = join(__dirname, '../../../../fixtures/ladder');
const RUNGS = readdirSync(LADDER, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const registry = createLanguageRegistry();
for (const language of BUILTIN_LANGUAGES) registry.register(language);
const languageOf = (path: string): string | undefined => registry.languageForPath(path);

/** The [filesystem] lines of a rung, comments stripped (a `#` at line start or after a space). */
function filesystemFacts(rung: string): string[][] {
  const facts: string[][] = [];
  let inSection = false;
  for (const raw of readFileSync(join(LADDER, rung, 'expected.cpg'), 'utf8').split('\n')) {
    const text = raw.replace(/(^|\s)#.*$/, '').trim();
    if (text === '') continue;
    const header = /^\[(\w+)\]$/.exec(text)?.[1];
    if (header !== undefined) inSection = header === 'filesystem';
    else if (inSection) facts.push(text.split(/\s+/));
  }
  return facts;
}

const decode = (raw: string): unknown => (raw === 'null' ? null : raw);
const edgeKey = (type: string | undefined, from: string, to: string): string =>
  `${type ?? '?'} ${from} -> ${to}`;

describe('the walker reproduces every ladder rung [filesystem] section', () => {
  it('finds all 13 rungs', () => {
    expect(RUNGS).toHaveLength(13);
  });

  it.each(RUNGS)('%s', async (rung) => {
    const ws = join(LADDER, rung, 'ws');
    const tier = filesystemTier(await walkWorkspace({ root: ws, languageOf }));
    const facts = filesystemFacts(rung);
    const problems: string[] = [];

    const nodeFacts = facts.filter((f) => f[2] !== '->');
    const edgeFacts = facts.filter((f) => f[2] === '->');
    const byId = new Map(tier.nodes.map((n) => [n.id, n]));

    const want = new Set(nodeFacts.map((f) => f[1]));
    if (byId.size !== tier.nodes.length) problems.push('duplicate node id');
    for (const n of tier.nodes) if (!want.has(n.id)) problems.push(`extra node ${n.id}`);
    for (const [label = '', id = '', ...props] of nodeFacts) {
      const node = byId.get(id);
      if (node === undefined) {
        problems.push(`missing node ${id}`);
        continue;
      }
      if (node.type !== label) problems.push(`${id} type ${node.type}, want ${label}`);
      for (const prop of props) {
        const [key = '', value = ''] = prop.split('=');
        const got = node.data?.[key];
        if (got !== decode(value)) problems.push(`${id} ${key}=${String(got)}, want ${value}`);
      }
    }

    const gotEdges = new Set(tier.edges.map((e) => edgeKey(e.type, e.source, e.target)));
    const wantEdges = new Set(edgeFacts.map(([t, from = '', , to = '']) => edgeKey(t, from, to)));
    for (const e of gotEdges) if (!wantEdges.has(e)) problems.push(`extra edge ${e}`);
    for (const e of wantEdges) if (!gotEdges.has(e)) problems.push(`missing edge ${e}`);
    if (gotEdges.size !== tier.edges.length) problems.push('duplicate edge');

    // Not on the ladder (golden: exclude), so checked against an independent sha256 of the bytes.
    for (const node of tier.nodes.filter((n) => n.type === 'FILE')) {
      const path = String(node.data?.['path']);
      const sha = createHash('sha256')
        .update(readFileSync(join(ws, ...path.split('/'))))
        .digest('hex');
      if (node.data?.['revision_id'] !== sha) problems.push(`${node.id} revision_id`);
      if (node.data?.['content_hash'] !== sha) problems.push(`${node.id} content_hash`);
    }

    expect(problems).toEqual([]);
  });
});
