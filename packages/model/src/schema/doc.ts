/**
 * The schema-doc renderer (U1.1.2): `CPG_SCHEMA` is the only source of the node/edge tables in
 * docs/outline/04-schema.yaml. These functions are pure string transforms (C-MODEL I-11: no I/O, no
 * clock, no randomness); `tools/schema-doc.mjs` and, later, `cpg schema --check` (U2a.4) do the fs.
 *
 * The generator owns only the bytes strictly between the line starting with `GENERATED_BEGIN` and the
 * line starting with `GENERATED_END`; the marker lines themselves are hand-owned.
 */
import * as enums from './enums';
import type { EdgeTypeSpec, NodeLabelSpec, PropertySpec } from './types';

/** Line prefixes that bound the generated region of docs/outline/04-schema.yaml. */
export const GENERATED_BEGIN = '# BEGIN GENERATED';
export const GENERATED_END = '# END GENERATED';

/** The part of CPG_SCHEMA the doc shows. CPG_SCHEMA satisfies it. */
export interface SchemaDocInput {
  readonly version: number;
  readonly nodes: readonly NodeLabelSpec[];
  readonly edges: readonly EdgeTypeSpec[];
}

/** The doc's name for each enums.ts export; looked up by array identity, never by contents (D6). */
const ENUM_NAMES: ReadonlyMap<readonly string[], string> = new Map<readonly string[], string>([
  [enums.NODE_STATUS, 'node_status'],
  [enums.RESOLUTION_STATUS, 'resolution_status'],
  [enums.INHERITS_RELATION, 'inherits_relation'],
  [enums.TYPE_DECL_KIND, 'type_decl_kind'],
  [enums.METHOD_KIND, 'method_kind'],
  [enums.CALL_KIND, 'call_kind'],
]);

const PLAIN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEYWORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
/** Characters YAML readers may treat as line breaks or non-printable: written as \u escapes. */
// oxlint-disable-next-line no-control-regex -- the point is to match and escape control characters.
const UNSAFE = /[\u007f-\u009f\u2028\u2029\ufeff]/g;

/** A double-quoted YAML scalar (JSON string syntax, plus \u escapes for line-break-like characters). */
const quoted = (v: string): string =>
  JSON.stringify(v).replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Plain when it cannot be read as anything but a string in YAML 1.1 and 1.2, double-quoted otherwise. */
const scalar = (v: string): string =>
  PLAIN.test(v) && !KEYWORDS.has(v.toLowerCase()) ? v : quoted(v);

const flowList = (xs: readonly string[]): string => `[${xs.map(scalar).join(', ')}]`;

function enumName(owner: string, p: PropertySpec): string | undefined {
  if (p.enumValues === undefined) return undefined;
  const name = ENUM_NAMES.get(p.enumValues);
  if (name === undefined)
    throw new Error(`schema-doc: ${owner}.${p.name} enumValues is not a declared enum (enums.ts)`);
  return name;
}

/** One `{ ... }` row per property; the five fixed columns are padded to the widest cell of their column. */
function propertyRows(owner: string, props: readonly PropertySpec[]): string[] {
  const fixed = props.map((p) => [
    `name: ${scalar(p.name)}`,
    `type: ${scalar(p.type)}`,
    `cardinality: ${scalar(p.cardinality)}`,
    `golden: ${scalar(p.golden)}`,
    `owner: ${scalar(p.owner)}`,
  ]);
  const widths = [0, 1, 2, 3, 4].map((c) => Math.max(...fixed.map((r) => (r[c] ?? '').length)) + 1);
  return props.map((p, i) => {
    const tail: string[] = [];
    const en = enumName(owner, p);
    if (en !== undefined) tail.push(`enum: ${en}`);
    if (p.doc !== '') tail.push(`doc: ${quoted(p.doc)}`);
    const cells = fixed[i] ?? [];
    const last = cells.length - 1;
    const head = cells
      .map((c, k) => (k < last || tail.length > 0 ? `${c},`.padEnd(widths[k] ?? 0) : c))
      .join(' ');
    return `      - { ${tail.length > 0 ? `${head} ${tail.join(', ')}` : head} }`;
  });
}

const DASHES = `# ${'-'.repeat(93)}`;
const banner = (title: string): string[] => [DASHES, `# ${title}`, DASHES];
const docLine = (doc: string): string[] => (doc === '' ? [] : [`    doc: ${quoted(doc)}`]);
const propBlock = (owner: string, props: readonly PropertySpec[]): string[] =>
  props.length === 0 ? ['    properties: []'] : ['    properties:', ...propertyRows(owner, props)];

function nodeEntry(n: NodeLabelSpec): string[] {
  return [
    `  - label: ${scalar(n.label)}`,
    `    cpg_co_label: ${String(n.cpgCoLabel)}`,
    `    has_file_property: ${String(n.hasFileProperty)}`,
    `    ownership: ${scalar(n.ownership)}`,
    `    write: ${scalar(n.write)}`,
    `    key: ${flowList(n.key)}`,
    ...propBlock(n.label, n.properties),
    ...docLine(n.doc),
  ];
}

function edgeEntry(e: EdgeTypeSpec): string[] {
  return [
    `  - type: ${scalar(e.type)}`,
    `    from: ${flowList(e.from)}`,
    `    to: ${flowList(e.to)}`,
    `    ownership: ${scalar(e.ownership)}`,
    `    write: ${scalar(e.write)}`,
    ...propBlock(e.type, e.properties),
    ...docLine(e.doc),
  ];
}

const section = (key: string, entries: readonly (readonly string[])[]): string[] =>
  entries.length === 0
    ? [`${key}: []`]
    : [`${key}:`, ...entries.flatMap((x, i) => (i === 0 ? x : ['', ...x]))];

/**
 * The YAML text of the generated region (nodes + edges tables), LF line endings, ending with '\n'.
 * Pure and deterministic. Throws Error('schema-doc: <LABEL>.<prop> enumValues is not a declared enum (enums.ts)')
 * when an enumValues array is not one of the enums.ts exports by identity.
 * REAL.
 */
export function renderSchemaRegion(schema: SchemaDocInput): string {
  const lines = [
    `# Generated by \`bun run schema:doc\` from CPG_SCHEMA (packages/model/src/schema), schema version ${schema.version}. Do not edit by hand.`,
    ...banner(`Node labels (${schema.nodes.length})`),
    ...section('nodes', schema.nodes.map(nodeEntry)),
    '',
    ...banner(`Edge types (${schema.edges.length})`),
    ...section('edges', schema.edges.map(edgeEntry)),
  ];
  return `${lines.join('\n')}\n`;
}

/** Start offsets of every line that begins with `marker`. */
function markerStarts(text: string, marker: string): number[] {
  const out: number[] = [];
  let at = 0;
  while (at <= text.length) {
    if (text.startsWith(marker, at)) out.push(at);
    const nl = text.indexOf('\n', at);
    if (nl === -1) break;
    at = nl + 1;
  }
  return out;
}

function exactlyOne(text: string, marker: string): number {
  const found = markerStarts(text, marker);
  const [first] = found;
  if (found.length !== 1 || first === undefined)
    throw new Error(
      `schema-doc: expected exactly one line starting with "${marker}", found ${found.length}`,
    );
  return first;
}

/**
 * `existing` with the bytes strictly between its BEGIN line and END line replaced by `region`.
 * Everything up to and including the BEGIN line's '\n', and everything from the END line's first byte, is
 * preserved byte-for-byte. Throws Error('schema-doc: expected exactly one line starting with "<marker>", found N')
 * or Error('schema-doc: "# END GENERATED" precedes "# BEGIN GENERATED"').
 * REAL.
 */
export function spliceGeneratedRegion(existing: string, region: string): string {
  const begin = exactlyOne(existing, GENERATED_BEGIN);
  const end = exactlyOne(existing, GENERATED_END);
  if (end < begin) throw new Error(`schema-doc: "${GENERATED_END}" precedes "${GENERATED_BEGIN}"`);
  const nl = existing.indexOf('\n', begin);
  return existing.slice(0, nl + 1) + region + existing.slice(end);
}
