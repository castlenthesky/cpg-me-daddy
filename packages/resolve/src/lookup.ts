// REAL (U6c.1a): the DefinitionLookup over a sealed set, the symbol index a resolver is handed at
// open() and applyResolutions reads. Built only from a sealed set: every file is extracted first.
import type { ExtractedFileSet, NodeElement } from '@cpg/extract';
import type { SourceRange, WorkspacePath } from '@cpg/model';
import type { DefinitionLookup } from './contract';

type Definer = { readonly fqn: string; readonly node: NodeElement };
const cmp = (r1: number, c1: number, r2: number, c2: number): number =>
  r1 !== r2 ? r1 - r2 : c1 - c2;
const encloses = (r: SourceRange, row: number, col: number): boolean =>
  cmp(r.startRow, r.startColumn, row, col) <= 0 && cmp(row, col, r.endRow, r.endColumn) < 0;
const isTighter = (a: SourceRange, b: SourceRange): boolean => {
  const s = cmp(a.startRow, a.startColumn, b.startRow, b.startColumn);
  return s !== 0 ? s > 0 : cmp(a.endRow, a.endColumn, b.endRow, b.endColumn) < 0;
};

/**
 * Reads only the set: no file, no fqn parsing, no name rebuilt into an fqn.
 *
 * - `hasSymbol(fqn)`: some file's `symbols` channel holds that fqn.
 * - `isIndexed(path)`: the set has a file at that path.
 * - A file's DEFINERS are its nodes that are the `from` (by id) of one of its DEFINES edges; each
 *   names that edge's `to` fqn.
 * - `symbolAt(path, row, column)`: in that file, the fqn of the definer whose `nameRange` starts
 *   exactly at (row, column); else of the definer whose `range` most tightly encloses it (start <=
 *   point < end, rows then columns; tightest = the latest start, then the earliest end); else
 *   undefined. When several definers qualify equally, the first in the file's node order.
 * - `symbolNamed(path, name)`: in that file, the fqn of the definer that a DECLARES edge from the
 *   file's MODULE points at and whose `name` property equals `name`; the last such in node order
 *   (a later module-level binding of a name replaces an earlier one); else undefined.
 * - A path the set does not hold answers undefined / false everywhere.
 */
export function createDefinitionLookup(set: ExtractedFileSet): DefinitionLookup {
  const symbols = new Set<string>();
  const byFile = new Map<WorkspacePath, { definers: Definer[]; named: Map<string, string> }>();

  for (const [path, file] of set.files) {
    for (const sym of file.symbols) symbols.add(sym.fqn);
    const modules = new Set(file.nodes.filter((n) => n.label === 'MODULE').map((n) => n.id));
    const defined = new Map<string, string>();
    const declared = new Set<string>();
    for (const e of file.edges) {
      if (e.from.by !== 'id') continue;
      if (e.type === 'DEFINES' && e.to.by === 'fqn') defined.set(e.from.key, e.to.key);
      else if (e.type === 'DECLARES' && e.to.by === 'id' && modules.has(e.from.key))
        declared.add(e.to.key);
    }
    const definers: Definer[] = [];
    const named = new Map<string, string>();
    for (const node of file.nodes) {
      const fqn = defined.get(node.id);
      if (fqn === undefined) continue;
      definers.push({ fqn, node });
      const name = node.properties['name'];
      if (declared.has(node.id) && typeof name === 'string') named.set(name, fqn);
    }
    byFile.set(path, { definers, named });
  }

  return {
    symbolAt(filePath, row, column) {
      const definers = byFile.get(filePath)?.definers;
      if (!definers) return undefined;
      const exact = definers.find(
        ({ node: { nameRange: nr } }) => nr?.startRow === row && nr.startColumn === column,
      );
      if (exact) return exact.fqn;
      let best: Definer | undefined;
      for (const d of definers) {
        const r = d.node.range;
        if (encloses(r, row, column) && (!best || isTighter(r, best.node.range))) best = d;
      }
      return best?.fqn;
    },
    symbolNamed: (filePath, name) => byFile.get(filePath)?.named.get(name),
    hasSymbol: (fqn) => symbols.has(fqn),
    isIndexed: (filePath) => byFile.has(filePath),
  };
}
