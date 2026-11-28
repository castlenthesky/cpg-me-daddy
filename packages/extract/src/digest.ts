// ExtractedFile's two hashes and the sealed set (controller decision 94; C-EXTRACT I18, Q7, ND-9).
// Pure and synchronous. `node:crypto`'s createHash is in-memory hashing, not I/O: the I2 trap
// (src/purity.test.ts) allows exactly that one builtin, which goes beyond the contract's text.

import { createHash } from 'node:crypto';
import type { WorkspacePath } from '@cpg/model';
import type { BuiltElements } from './builder';
import type {
  ExtractedFile,
  ExtractedFileSet,
  NodeElement,
  RefSite,
  SealExtractedFiles,
} from './contract';

/** A module-level import binding that is part of the file's exported surface (decision 94). */
export type ReExport = NonNullable<RefSite['importBinding']>;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonical(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function fnv1a32(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * `fnv1a32:<8 lowercase hex>`, the content anchor. A pure function of the four arrays that ignores
 * `revision_id` (I18) and the order inside each array (decision 94: a sorted projection):
 * - each element becomes one line: `N:` + canonical(node without its `revision_id` field), `S:` +
 *   canonical(symbol), `E:` + canonical(edge), `R:` + canonical(ref site);
 * - canonical(v) is JSON with no whitespace, every object's keys sorted by UTF-16 code unit, arrays
 *   in their own order;
 * - the lines are sorted by UTF-16 code unit and joined with `\n`;
 * - FNV-1a 32-bit over the UTF-16 code units of that text (offset 2166136261, prime 16777619), the
 *   spelling `@cpg/model`'s graphDigest uses. Four empty arrays give `fnv1a32:811c9dc5`.
 */
export function elementDigest(elements: BuiltElements): string {
  const lines: string[] = [];
  for (const node of elements.nodes) {
    const { revision_id: _revisionId, ...rest } = node;
    lines.push(`N:${canonical(rest)}`);
  }
  for (const symbol of elements.symbols) {
    lines.push(`S:${canonical(symbol)}`);
  }
  for (const edge of elements.edges) {
    lines.push(`E:${canonical(edge)}`);
  }
  for (const site of elements.refSites) {
    lines.push(`R:${canonical(site)}`);
  }
  return fnv1a32(lines.toSorted(compareCodeUnits).join('\n'));
}

/**
 * `sha256:<64 lowercase hex>` of the exported surface (ND-9; decision 94), which U7 compares to gate
 * the cascade:
 * - the surface is every node whose `properties.exported` is `true`, as the entry
 *   `[id, kind, signature]`, where kind and signature are those string properties or `null`;
 * - the id stands for decision 94's name: it is the qualified name (two classes' same-named methods
 *   stay apart) and carries the label (a MEMBER has no kind). `exported` is the filter;
 * - the entries are sorted by their JSON text (UTF-16 code unit) and the hash is sha256 over the UTF-8
 *   of `JSON.stringify(sortedEntries)`. No exported node gives sha256 of `[]`.
 * Ranges, docstrings and revision_id do not enter: moving a function down the file changes nothing.
 * Python's `__all__` is a documented gap.
 *
 * SEAT (BMO-134): `reexports` is ignored until the implementation lands. Each re-export (a module-level
 * import binding Pass B found exported) is one more entry, sorted with the rest:
 * `[local, 'reexport', source]`, where source is `.` repeated relativeDepth times, then module, then
 * `:` and imported when imported is present (`from .core import Engine` gives
 * `["Engine","reexport",".core:Engine"]`, `import os` gives `["os","reexport","os"]`). No id enters,
 * so reordering the imports changes nothing.
 */
export function interfaceHash(
  nodes: readonly NodeElement[],
  _reexports: readonly ReExport[] = [],
): string {
  const sortedEntries = nodes
    .filter((node) => node.properties['exported'] === true)
    .map((node) => {
      const kind = node.properties['kind'];
      const signature = node.properties['signature'];
      const entry: readonly [string, string | null, string | null] = [
        node.id,
        typeof kind === 'string' ? kind : null,
        typeof signature === 'string' ? signature : null,
      ];
      return { entry, text: JSON.stringify(entry) };
    })
    .toSorted((a, b) => compareCodeUnits(a.text, b.text))
    .map((item) => item.entry);
  const digest = createHash('sha256').update(JSON.stringify(sortedEntries), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/**
 * The only way to mint an ExtractedFileSet (L-20, L-44: resolution runs after every file is extracted).
 * - Two files with one path: `failed`, `duplicatePaths` = each repeated path once, sorted by UTF-16
 *   code unit.
 * - Otherwise `ok`: `files` maps each path to its file, inserted in path order (UTF-16 code unit);
 *   `refSites` is every file's ref sites, sorted by (the file's path, site id), both by code unit.
 */
export const sealExtractedFiles: SealExtractedFiles = (input) => {
  const list = [...input];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const file of list) {
    if (seen.has(file.path)) {
      duplicates.add(file.path);
    } else {
      seen.add(file.path);
    }
  }
  if (duplicates.size > 0) {
    return { kind: 'failed', duplicatePaths: [...duplicates].toSorted(compareCodeUnits) };
  }

  const sortedFiles = list.toSorted((a, b) => compareCodeUnits(a.path, b.path));
  const fileMap = new Map<WorkspacePath, ExtractedFile>();
  const collectedSites: RefSite[] = [];
  for (const file of sortedFiles) {
    fileMap.set(file.path, file);
    for (const site of file.refSites.toSorted((a, b) => compareCodeUnits(a.id, b.id))) {
      collectedSites.push(site);
    }
  }

  const files: ReadonlyMap<WorkspacePath, ExtractedFile> = fileMap;
  const refSites: readonly RefSite[] = collectedSites;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decision 88: only sealExtractedFiles mints the brand.
  const set = { files, refSites } as ExtractedFileSet;
  return { kind: 'ok', set };
};
