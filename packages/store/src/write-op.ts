// toWriteOp (C-STORE, DQ-03 fold; controller decision 97): the store builds the code tier's
// replace-file from the extracted file and its resolved edges. A delta cannot build it (CS-3).

import type { EdgeElement, ExtractedFile } from '@cpg/extract';
import type { WriteOp } from './contract';

/** The replace-file arm of WriteOp. */
type ReplaceFileOp = WriteOp & { readonly kind: 'replace-file' };

/**
 * The one replace-file for `file` at `seq`: `file`, `seq` and `revision_id` from the file, then
 *
 * - nodes: one row per NodeElement (label, key = its id; properties = its properties plus `file`,
 *   its own `revision_id` and `range` formatted by `formatRange`; these fields win over a property of
 *   the same name), then one SYMBOL row per SymbolElement (key = fqn; its properties plus `fqn` and
 *   `language`), then one FILE row carrying the FILE's code-owned half only (`interface_hash` from
 *   `interfaceHash`, `loc` from `stats.lineCount`). `tier`, `nameRange` and `origin` are not
 *   written: the schema has no property for them.
 * - edges: the file's own edges, then `edges` (the resolve pass's), each endpoint's label and key
 *   copied from its EndpointRef.
 *
 * SOURCE_FILE is not added here: the engine attaches it (C-EXTRACT Q8, decision 101). Pure: it
 * mutates nothing and the op shares no object with its inputs. Throws what `formatRange` throws on
 * an invalid range (a producer bug).
 */
export function toWriteOp(
  _file: ExtractedFile,
  _edges: readonly EdgeElement[],
  _seq: number,
): ReplaceFileOp {
  // SEAT: U6a.3-1 implements it
  throw new Error('SEAT: toWriteOp lands in U6a.3-1');
}
