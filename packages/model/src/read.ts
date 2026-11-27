/**
 * Typed read-back of the open `data` bag: `data.location` on a node, `data.resolution` on a node or
 * an edge. Each accessor answers in three states, so "the producer wrote nothing" (`absent`) and
 * "the producer wrote garbage" (`malformed`) are told apart instead of both collapsing to
 * `undefined` (C-MODEL I-14, L-08).
 *
 * Imports from `./index` are types only, so there is no runtime cycle with the re-export there.
 */
import type { EdgeResolution, GraphEdge, GraphNode, NodeLocation, SourceRange } from './index';
import { isWorkspacePath } from './paths';

/** The closed set of transport-level defects (C-MODEL `ModelDefect`). */
export type ModelDefectCode =
  | 'empty-id'
  | 'id-contains-separator'
  | 'duplicate-node-id'
  | 'dangling-edge'
  | 'malformed-location'
  | 'malformed-resolution'
  | 'non-monotonic-seq';

/** One defect: a code plus the locators a consumer filters on. Flat by design (no consumer switches on a union). */
export interface ModelDefect {
  readonly code: ModelDefectCode;
  /** One deterministic line naming the offender and the rule broken. For humans and logs; never parsed. */
  readonly detail: string;
  /**
   * The id concerned: the node's own id, or (dangling-edge, empty-id/separator on an endpoint) the
   * endpoint's id. Absent for non-monotonic-seq. A non-string id is rendered with JSON.stringify
   * into `detail` only.
   */
  readonly nodeId?: string;
  /** Index into payload.nodes (validatePayload only). */
  readonly nodeIndex?: number;
  /** Index into payload.edges (validatePayload only). */
  readonly edgeIndex?: number;
  /** Which end of edgeIndex the defect is on (dangling-edge, and id defects on an endpoint). */
  readonly endpoint?: 'source' | 'target';
}

/**
 * The result of reading one key from a `data` bag. `absent`: the key is `undefined` or `null`.
 * `malformed`: anything else that fails the shape check. A `present` value is a fresh object holding
 * only the declared keys, never the stored reference.
 */
export type Read<T> =
  | { readonly state: 'present'; readonly value: T }
  | { readonly state: 'absent' }
  | { readonly state: 'malformed'; readonly defect: ModelDefect };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isPresent = (v: unknown): boolean => v !== undefined && v !== null;

const isCoord = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Four non-negative safe integers with (start) <= (end) in (row, column) order; returns a fresh object. */
function readRange(v: unknown): SourceRange | undefined {
  if (!isRecord(v)) return undefined;
  const { startRow, startColumn, endRow, endColumn } = v;
  if (!isCoord(startRow) || !isCoord(startColumn) || !isCoord(endRow) || !isCoord(endColumn)) {
    return undefined;
  }
  if (endRow < startRow || (endRow === startRow && endColumn < startColumn)) return undefined;
  return { startRow, startColumn, endRow, endColumn };
}

function bad(
  code: 'malformed-location' | 'malformed-resolution',
  what: string,
  nodeId?: string,
): { readonly state: 'malformed'; readonly defect: ModelDefect } {
  const detail = `${what} is malformed`;
  return {
    state: 'malformed',
    defect: nodeId === undefined ? { code, detail } : { code, detail, nodeId },
  };
}

function readLocationValue(raw: unknown): NodeLocation | undefined {
  if (!isRecord(raw)) return undefined;
  const { filePath } = raw;
  if (typeof filePath !== 'string' || filePath === '.' || !isWorkspacePath(filePath))
    return undefined;
  const range = readRange(raw['range']);
  if (range === undefined) return undefined;
  if (!isPresent(raw['nameRange'])) return { filePath, range };
  const nameRange = readRange(raw['nameRange']);
  return nameRange === undefined ? undefined : { filePath, range, nameRange };
}

function readResolutionValue(raw: unknown): EdgeResolution | undefined {
  if (!isRecord(raw)) return undefined;
  const { status, resolvedBy, confidence, reason } = raw;
  if (typeof status !== 'string' || status === '') return undefined;
  if (typeof resolvedBy !== 'string' || resolvedBy === '') return undefined;
  const out: { status: string; resolvedBy: string; confidence?: number; reason?: string } = {
    status,
    resolvedBy,
  };
  if (isPresent(confidence)) {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return undefined;
    if (confidence < 0 || confidence > 1) return undefined;
    out.confidence = confidence;
  }
  if (isPresent(reason)) {
    if (typeof reason !== 'string') return undefined;
    out.reason = reason;
  }
  return out;
}

/**
 * The location the code tier writes as schema properties (controller decision 108), read when
 * `data.location` is absent and `data.range` or `data.name_range` is present:
 *
 * - `data.range` is the schema's `range` string (04-schema.yaml, `formatRange`):
 *   `startLine:startCol-endLine:endCol`, lines 1-based, columns 0-based UTF-16, end exclusive. Read
 *   back exactly as `formatRange` writes it: four decimals with no sign and no leading zero (a lone
 *   `0` is a zero), each a safe integer as written, both lines >= 1, and the end not before the
 *   start. Row = line - 1, column as written: the one 1-based to 0-based conversion.
 * - `data.file` is the owning file: a WorkspacePath (`isWorkspacePath`) other than `'.'`.
 * - `data.name_range`, when present (not undefined or null), is a second string of the same form.
 *
 * Present: `{ filePath: file, range }`, plus `nameRange` when `name_range` is present; fresh objects
 * holding only those keys. Otherwise malformed, code `malformed-location`, `nodeId` = node.id, detail
 * `node <JSON id> data.<key> is malformed` for the first key that fails, in the order `range`, `file`,
 * `name_range` (a missing `range` fails as `range`).
 */
// SEAT (decision 108)
function readSchemaLocation(node: GraphNode): Read<NodeLocation> {
  throw new Error(`SEAT: readSchemaLocation(${node.id}) is decision 108`);
}

/**
 * data.location -> Read<NodeLocation>. A malformed result is code 'malformed-location' with
 * nodeId = node.id.
 *
 * Controller decision 108 (a C-MODEL amendment): when `data.location` is absent the node's schema
 * properties are read instead (readSchemaLocation). The result is absent only when `data.location`,
 * `data.range` and `data.name_range` are all absent; `data.file` alone is no location. A present but
 * malformed `data.location` is malformed whatever the schema properties say (I-14).
 */
// REAL
export function readNodeLocation(node: GraphNode): Read<NodeLocation> {
  const raw = node.data?.['location'];
  if (!isPresent(raw)) {
    const schema = isPresent(node.data?.['range']) || isPresent(node.data?.['name_range']);
    return schema ? readSchemaLocation(node) : { state: 'absent' };
  }
  const value = readLocationValue(raw);
  return value === undefined
    ? bad('malformed-location', `node ${JSON.stringify(node.id)} data.location`, node.id)
    : { state: 'present', value };
}

/**
 * data.resolution on a reference node: how a `CALL`/`IMPORT` explains itself when it has no
 * outgoing edge. A malformed result is 'malformed-resolution' with nodeId = node.id.
 */
// REAL
export function readNodeResolution(node: GraphNode): Read<EdgeResolution> {
  const raw = node.data?.['resolution'];
  if (!isPresent(raw)) return { state: 'absent' };
  const value = readResolutionValue(raw);
  return value === undefined
    ? bad('malformed-resolution', `node ${JSON.stringify(node.id)} data.resolution`, node.id)
    : { state: 'present', value };
}

/** data.resolution on an edge. A malformed result is 'malformed-resolution' with no locator (validatePayload adds edgeIndex). */
// REAL
export function readEdgeResolution(edge: GraphEdge): Read<EdgeResolution> {
  const raw = edge.data?.['resolution'];
  if (!isPresent(raw)) return { state: 'absent' };
  const value = readResolutionValue(raw);
  return value === undefined
    ? bad('malformed-resolution', 'edge data.resolution')
    : { state: 'present', value };
}
