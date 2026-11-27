// The ladder's hand-written expectations (fixtures/ladder) must speak this package's vocabulary.
// This checks form, not truth: a person reading ws/ checks that each line is true.
// Each check collects every problem it finds and asserts the list is empty, so one run names them all.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PropertySpec, SymbolDescriptor, SymbolDescriptorKind } from './schema';
import { edgeSpec, makeNodeId, makeSymbolFqn, MODULE_SCOPE, nodeSpec, parseNodeId } from './schema';

const LADDER = join(__dirname, '../../../fixtures/ladder');
const SECTIONS = ['parse', 'filesystem', 'structural', 'symbols', 'resolution'] as const;
type Section = (typeof SECTIONS)[number];
const isSection = (name: string): name is Section => (SECTIONS as readonly string[]).includes(name);

/** The SCIP descriptor each declaring label's SYMBOL ends with (04-schema.yaml SYMBOL.fqn). */
const DESCRIPTOR_END: Readonly<Record<string, string>> = {
  MODULE: '/',
  TYPE_DECL: '#',
  METHOD: ').',
  MEMBER: '.',
};

/** The descriptor each enclosing declaration contributes; MODULE is the fqn's owner, not a descriptor. */
const DESCRIPTOR_KIND: Readonly<Record<string, SymbolDescriptorKind>> = {
  TYPE_DECL: 'type',
  METHOD: 'method',
  MEMBER: 'term',
};

/** The section that owns each label or edge type; anything not listed is `structural`. */
const OWNER: Readonly<Record<string, Section>> = {
  DIRECTORY: 'filesystem',
  FILE: 'filesystem',
  HAS_ENTRY: 'filesystem',
  DEFINES: 'symbols',
  CALLS: 'resolution',
  IMPORTS: 'resolution',
};

interface Fact {
  readonly section: Section;
  readonly at: string;
  readonly words: readonly string[];
}

function readFacts(rung: string, problems: string[]): Fact[] {
  const facts: Fact[] = [];
  let section: Section | undefined;
  const lines = readFileSync(join(LADDER, rung, 'expected.cpg'), 'utf8').split('\n');
  lines.forEach((raw, index) => {
    const at = `${rung}/expected.cpg:${String(index + 1)}`;
    // A comment starts at a `#` that begins the line or follows whitespace; SCIP fqns hold `#` too.
    const text = raw.replace(/(^|\s)#.*$/, '').trim();
    if (text === '') return;
    const header = /^\[(\w+)\]$/.exec(text)?.[1];
    if (header !== undefined) {
      if (isSection(header)) section = header;
      else problems.push(`${at} unknown section [${header}]`);
    } else if (section === undefined) problems.push(`${at} fact before any section`);
    else facts.push({ section, at, words: text.split(/\s+/) });
  });
  return facts;
}

function walk(root: string, dir: string, files: string[], dirs: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const list = statSync(path).isDirectory() ? dirs : files;
    list.push(relative(root, path));
    if (list === dirs) walk(root, path, files, dirs);
  }
}

/** The label a node id names, or undefined when the id is not canonical. */
function labelOf(id: string): string | undefined {
  const parts = parseNodeId(id);
  if (parts?.form === 'file') return 'FILE';
  if (parts?.form === 'directory') return 'DIRECTORY';
  return parts?.kind;
}

/**
 * The fqn a DEFINES from `id` must target: the path, then one descriptor per declaration on the rung whose
 * scope is a prefix of `id`'s scope (controller decisions 89 and 90). A message when the chain breaks.
 */
function expectedSymbol(
  id: string,
  declared: ReadonlyMap<string | undefined, string | undefined>,
): string {
  const parts = parseNodeId(id);
  if (parts?.form !== 'scoped') return `(not a scoped id: ${id})`;
  const scope = parts.scope[0] === MODULE_SCOPE ? [] : parts.scope;
  const descriptors: SymbolDescriptor[] = [];
  for (const [i, name] of scope.entries()) {
    const frames: [string, ...string[]] = [scope[0] ?? name, ...scope.slice(1, i + 1)];
    const label = Object.keys(DESCRIPTOR_KIND).find((kind) =>
      declared.has(makeNodeId({ form: 'scoped', path: parts.path, kind, scope: frames })),
    );
    const kind = DESCRIPTOR_KIND[label ?? ''];
    if (kind === undefined) return `(no declaration on the rung for ${frames.join('.')})`;
    descriptors.push({ kind, name });
  }
  return makeSymbolFqn({ form: 'local', path: parts.path, descriptors });
}

function checkProperties(
  fact: Fact,
  owner: string,
  specs: readonly PropertySpec[],
  pairs: readonly string[],
  problems: string[],
): void {
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const spec = specs.find((p) => p.name === pair.slice(0, eq));
    if (eq <= 0) problems.push(`${fact.at} expected key=value, got "${pair}"`);
    else if (spec === undefined) problems.push(`${fact.at} ${owner} has no property ${pair}`);
    else if (spec.enumValues?.includes(pair.slice(eq + 1)) === false)
      problems.push(`${fact.at} ${pair} is not one of ${spec.enumValues.join('|')}`);
  }
}

const rungs = readdirSync(LADDER).filter((name) => statSync(join(LADDER, name)).isDirectory());

describe('fixtures/ladder', () => {
  it('numbers its rungs from 00 without gaps', () => {
    expect(new Set(rungs.map((r) => r.slice(0, 2)))).toEqual(
      new Set(rungs.map((_, i) => String(i).padStart(2, '0'))),
    );
  });

  describe.each(rungs)('%s', (rung) => {
    const parseProblems: string[] = [];
    const facts = readFacts(rung, parseProblems);
    const files: string[] = [];
    const dirs: string[] = [];
    walk(join(LADDER, rung, 'ws'), join(LADDER, rung, 'ws'), files, dirs);
    const parseFacts = facts.filter((f) => f.section === 'parse');
    const nodeFacts = facts.filter((f) => f.section !== 'parse' && !f.words.includes('->'));
    const edgeFacts = facts.filter((f) => f.words.includes('->'));
    const declared = new Map(nodeFacts.map((f) => [f.words[1], f.words[0]]));

    it('reads as sections of facts', () => {
      expect(parseProblems).toEqual([]);
    });

    it('[parse] names every file in ws/ exactly once', () => {
      const problems: string[] = [];
      for (const f of parseFacts) {
        const keys = f.words.slice(2).map((w) => w.split('=')[0]);
        if (f.words[0] === 'SKIP' && keys.length === 0) continue;
        if (f.words[0] !== 'PARSE' || keys.join() !== 'language,root,hasError')
          problems.push(`${f.at} expected PARSE <path> language= root= hasError=, or SKIP <path>`);
      }
      expect(problems).toEqual([]);
      const named = parseFacts.map((f) => f.words[1]);
      expect(named).toHaveLength(files.length);
      expect(new Set(named)).toEqual(new Set(files));
    });

    it('[filesystem] has a FILE per file and a DIRECTORY per directory, root included', () => {
      const ids = new Map<string, string[]>();
      for (const [label = '', id = ''] of nodeFacts.map((f) => f.words))
        ids.set(label, [...(ids.get(label) ?? []), id]);
      expect(new Set(ids.get('FILE'))).toEqual(new Set(files.map((p) => `file:${p}`)));
      expect(new Set(ids.get('DIRECTORY'))).toEqual(
        new Set(['dir:.', ...dirs.map((d) => `dir:${d}`)]),
      );
    });

    it('every node line is a known label with a canonical id, a real file and known properties', () => {
      const problems: string[] = [];
      for (const f of nodeFacts) {
        const [label = '', id = '', ...pairs] = f.words;
        const spec = nodeSpec(label);
        const path = parseNodeId(id)?.path ?? '';
        if (spec === undefined) problems.push(`${f.at} unknown label ${label}`);
        if (labelOf(id) !== label) problems.push(`${f.at} id ${id} does not name a ${label}`);
        if (label !== 'DIRECTORY' && !files.includes(path))
          problems.push(`${f.at} ${path} is not in ws/`);
        checkProperties(f, label, spec?.properties ?? [], pairs, problems);
      }
      expect(problems).toEqual([]);
    });

    it('every edge line is a known type between allowed, declared endpoints', () => {
      const problems: string[] = [];
      for (const f of edgeFacts) {
        const [type = '', from = '', arrow = '', to = '', ...pairs] = f.words;
        const spec = edgeSpec(type);
        const labels = [from, to].map((end) =>
          end.startsWith('`') ? 'SYMBOL' : declared.get(end),
        );
        if (arrow !== '->') problems.push(`${f.at} expected TYPE <from> -> <to>`);
        if (spec === undefined) problems.push(`${f.at} unknown edge ${type}`);
        if (labels[0] === undefined) problems.push(`${f.at} undeclared ${from}`);
        if (labels[1] === undefined) problems.push(`${f.at} undeclared ${to}`);
        if (spec !== undefined && !spec.from.includes(labels[0] ?? ''))
          problems.push(`${f.at} ${type} may not start at ${String(labels[0])}`);
        if (spec !== undefined && !spec.to.includes(labels[1] ?? ''))
          problems.push(`${f.at} ${type} may not end at ${String(labels[1])}`);
        checkProperties(f, type, spec?.properties ?? [], pairs, problems);
      }
      expect(problems).toEqual([]);
    });

    it("every DEFINES target is a SCIP fqn in its source's file, ending as its label requires", () => {
      const problems: string[] = [];
      for (const f of edgeFacts.filter((x) => x.words[0] === 'DEFINES')) {
        const [, from = '', , to = ''] = f.words;
        const label = declared.get(from) ?? '';
        const prefix = `\`${parseNodeId(from)?.path ?? ''}\`/`;
        const end = DESCRIPTOR_END[label] ?? '';
        if (!to.startsWith(prefix)) problems.push(`${f.at} ${to} is not under ${prefix}`);
        if (!to.endsWith(end)) problems.push(`${f.at} a ${label} symbol ends with "${end}": ${to}`);
      }
      expect(problems).toEqual([]);
    });

    it('every DEFINES target is the fqn of its source and the declarations around it', () => {
      const problems: string[] = [];
      for (const f of edgeFacts.filter((x) => x.words[0] === 'DEFINES')) {
        const [, from = '', , to = ''] = f.words;
        const want = expectedSymbol(from, declared);
        if (to !== want) problems.push(`${f.at} ${to} is not ${want}`);
      }
      expect(problems).toEqual([]);
    });

    it('no PARAM defines a SYMBOL in v1 (controller decision 91)', () => {
      const params = edgeFacts
        .filter((f) => f.words[0] === 'DEFINES' && declared.get(f.words[1]) === 'PARAM')
        .map((f) => f.at);
      expect(params).toEqual([]);
    });

    it('puts each fact in the section that owns it', () => {
      const misplaced = [...nodeFacts, ...edgeFacts]
        .filter((f) => f.section !== (OWNER[f.words[0] ?? ''] ?? 'structural'))
        .map((f) => `${f.at} ${f.words[0] ?? ''} belongs in another section`);
      expect(misplaced).toEqual([]);
    });
  });
});
