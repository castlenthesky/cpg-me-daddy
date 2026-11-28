// SEAT (U6c.1a): the DefinitionLookup over a sealed set, the symbol index a resolver is handed at
// open() and applyResolutions reads. Built only from a sealed set: every file is extracted first.
import type { ExtractedFileSet } from '@cpg/extract';
import type { DefinitionLookup } from './contract';

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
export function createDefinitionLookup(_set: ExtractedFileSet): DefinitionLookup {
  throw new Error('SEAT: createDefinitionLookup lands in U6c.1a');
}
