// Hand-built extract output for resolve tests. A resolve test may import one sibling (check-deps rule
// 5), so files are written out rather than parsed; their ids, fqns and ranges follow the ladder's
// formats (fixtures/ladder/README.md) with 0-based rows.
import {
  sealExtractedFiles,
  type EdgeElement,
  type ExtractedFile,
  type ExtractedFileSet,
  type FileOwnedLabel,
  type NodeElement,
  type PropertyValue,
  type RefSite,
} from '@cpg/extract';
import type { SourceRange, WorkspacePath } from '@cpg/model';
import { wsPath } from './chain-contract';

/** [startRow, startColumn, endRow, endColumn], 0-based, end exclusive. */
export type Span = readonly [number, number, number, number];

export function span([startRow, startColumn, endRow, endColumn]: Span): SourceRange {
  return { startRow, startColumn, endRow, endColumn };
}

export function node(
  label: FileOwnedLabel,
  id: string,
  file: WorkspacePath,
  range: Span,
  properties: Readonly<Record<string, PropertyValue>>,
  nameRange?: Span,
): NodeElement {
  return {
    label,
    id,
    file,
    revision_id: '5d'.repeat(32),
    tier: 'structural',
    range: span(range),
    ...(nameRange === undefined ? {} : { nameRange: span(nameRange) }),
    properties,
  };
}

export function defines(label: FileOwnedLabel, id: string, fqn: string): EdgeElement {
  return {
    type: 'DEFINES',
    from: { by: 'id', label, key: id },
    to: { by: 'fqn', label: 'SYMBOL', key: fqn },
    properties: {},
  };
}

export function declares(
  fromLabel: FileOwnedLabel,
  from: string,
  toLabel: FileOwnedLabel,
  to: string,
): EdgeElement {
  return {
    type: 'DECLARES',
    from: { by: 'id', label: fromLabel, key: from },
    to: { by: 'id', label: toLabel, key: to },
    properties: {},
  };
}

export interface FileParts {
  readonly nodes?: readonly NodeElement[];
  readonly symbols?: readonly string[];
  readonly builtins?: readonly string[];
  readonly edges?: readonly EdgeElement[];
  readonly refSites?: readonly RefSite[];
}

export function extracted(path: string, parts: FileParts): ExtractedFile {
  const local = (parts.symbols ?? []).map((fqn) => ({
    fqn,
    origin: 'local' as const,
    language: 'python',
    properties: {},
  }));
  const builtin = (parts.builtins ?? []).map((fqn) => ({
    fqn,
    origin: 'builtin' as const,
    language: 'python',
    properties: { kind: 'function' },
  }));
  return {
    path: wsPath(path),
    grammarId: 'python',
    revision_id: '5d'.repeat(32),
    nodes: parts.nodes ?? [],
    symbols: [...local, ...builtin],
    edges: parts.edges ?? [],
    refSites: parts.refSites ?? [],
    stats: { astNodesVisited: 0, structuralNodes: 0, expressionNodes: 0, lineCount: 0 },
    elementDigest: 'e'.repeat(64),
    interfaceHash: 'f'.repeat(64),
  };
}

export function seal(...files: readonly ExtractedFile[]): ExtractedFileSet {
  const outcome = sealExtractedFiles(files);
  if (outcome.kind !== 'ok')
    throw new Error(`duplicate paths: ${outcome.duplicatePaths.join(', ')}`);
  return outcome.set;
}
