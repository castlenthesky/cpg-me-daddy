// ExtractedFile's two hashes and the sealed set (controller decision 94; C-EXTRACT I18, Q7, ND-9).
// Pure and synchronous. `node:crypto`'s createHash is in-memory hashing, not I/O: the I2 trap
// (src/purity.test.ts) allows exactly that one builtin, which goes beyond the contract's text.

import type { BuiltElements } from './builder';
import type { NodeElement, SealExtractedFiles } from './contract';

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
export function elementDigest(_elements: BuiltElements): string {
  throw new Error('SEAT: elementDigest lands in U6a.2-2');
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
 * Re-exports join when IMPORT nodes exist (U6a.2-4, U6b); Python's `__all__` is a documented gap.
 */
export function interfaceHash(_nodes: readonly NodeElement[]): string {
  throw new Error('SEAT: interfaceHash lands in U6a.2-2');
}

/**
 * The only way to mint an ExtractedFileSet (L-20, L-44: resolution runs after every file is extracted).
 * - Two files with one path: `failed`, `duplicatePaths` = each repeated path once, sorted by UTF-16
 *   code unit.
 * - Otherwise `ok`: `files` maps each path to its file, inserted in path order (UTF-16 code unit);
 *   `refSites` is every file's ref sites, sorted by (the file's path, site id), both by code unit.
 */
export const sealExtractedFiles: SealExtractedFiles = () => {
  throw new Error('SEAT: sealExtractedFiles lands in U6a.2-2');
};
