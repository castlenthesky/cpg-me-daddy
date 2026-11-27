// toWriteOp (C-STORE, DQ-03 fold; controller decision 97): the store builds the code tier's
// replace-file from the extracted file and its resolved edges. A delta cannot build it (CS-3).

import type { EdgeElement, ExtractedFile, PropertyValue } from '@cpg/extract';
import { formatRange } from '@cpg/model';
import type { EdgeRow, NodeRow, WriteOp } from './contract';

/** The replace-file arm of WriteOp. */
type ReplaceFileOp = WriteOp & { readonly kind: 'replace-file' };

function copyProperties(
  properties: Readonly<Record<string, PropertyValue>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/**
 * The one replace-file for `file` at `seq`: `file`, `seq` and `revision_id` from the file, then
 *
 * - nodes: one row per NodeElement (label, key = its id; properties = its properties plus `file`,
 *   its own `revision_id`, `range` formatted by `formatRange`, and `name_range` formatted by
 *   `formatRange` when `nameRange` is present; these fields win over a property of the same name),
 *   then one SYMBOL row per SymbolElement (key = fqn; its properties plus `fqn` and `language`),
 *   then one FILE row carrying the FILE's code-owned half only (`interface_hash` from
 *   `interfaceHash`, `loc` from `stats.lineCount`). `tier` and `origin` are not written: the schema
 *   has no property for them.
 * - edges: the file's own edges, then `edges` (the resolve pass's), each endpoint's label and key
 *   copied from its EndpointRef.
 *
 * SOURCE_FILE is not added here: the engine attaches it (C-EXTRACT Q8, decision 101). Pure: it
 * mutates nothing and the op shares no object with its inputs. Throws what `formatRange` throws on
 * an invalid range (a producer bug).
 */
export function toWriteOp(
  file: ExtractedFile,
  edges: readonly EdgeElement[],
  seq: number,
): ReplaceFileOp {
  // REAL
  const nodes: NodeRow[] = [
    ...file.nodes.map((node): NodeRow => ({
      label: node.label,
      key: node.id,
      properties: {
        ...copyProperties(node.properties),
        file: node.file,
        revision_id: node.revision_id,
        range: formatRange(node.range),
        ...(node.nameRange !== undefined ? { name_range: formatRange(node.nameRange) } : {}),
      },
    })),
    ...file.symbols.map((symbol): NodeRow => ({
      label: 'SYMBOL',
      key: symbol.fqn,
      properties: {
        ...copyProperties(symbol.properties),
        fqn: symbol.fqn,
        language: symbol.language,
      },
    })),
    {
      label: 'FILE',
      key: file.path,
      properties: {
        interface_hash: file.interfaceHash,
        loc: file.stats.lineCount,
      },
    },
  ];

  const edgeRows: EdgeRow[] = [...file.edges, ...edges].map((edge): EdgeRow => ({
    type: edge.type,
    fromLabel: edge.from.label,
    fromKey: edge.from.key,
    toLabel: edge.to.label,
    toKey: edge.to.key,
    properties: copyProperties(edge.properties),
  }));

  return {
    kind: 'replace-file',
    file: file.path,
    seq,
    revision_id: file.revision_id,
    nodes,
    edges: edgeRows,
  };
}
