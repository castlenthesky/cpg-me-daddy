/**
 * `validatePayload`: names every transport-level defect in a `GraphPayload` (C-MODEL I-3, I-4, I-9,
 * I-14, seq). It reports and never repairs: a dangling edge stays in the payload (I-9), and
 * rejecting is the caller's policy (the sink, `cpg verify`).
 *
 * Imports from `./index` are types only, so there is no runtime cycle with the re-export there.
 */
import type { GraphPayload } from './index';
import { readEdgeResolution, readNodeLocation, readNodeResolution } from './read';
import type { ModelDefect } from './read';

export interface ValidatePayloadOptions {
  /**
   * The seq of the payload this one supersedes. A lower payload.seq is non-monotonic-seq; an equal
   * one is not (a resync snapshot). A non-safe-integer previousSeq adds no defect.
   */
  readonly previousSeq?: number;
}

/**
 * Every transport-level defect, in a fixed order: the seq defect, then nodes by index, then edges by
 * index. Pure, never throws, never mutates; an empty array means clean. Shape checks on
 * `data.location`/`data.resolution` go through the `read*` accessors, so the two cannot drift.
 */
// REAL
export function validatePayload(
  payload: GraphPayload,
  options?: ValidatePayloadOptions,
): readonly ModelDefect[] {
  const out: ModelDefect[] = [];
  const { seq } = payload as { seq: unknown };
  const previousSeq = options?.previousSeq;
  if (
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < -1 ||
    (previousSeq !== undefined && seq < previousSeq)
  ) {
    out.push({
      code: 'non-monotonic-seq',
      detail: `seq ${String(seq)} is not a safe integer >= -1${previousSeq === undefined ? '' : ` and >= previous seq ${String(previousSeq)}`}`,
    });
  }

  const ids = new Set<string>();
  const firstIndex = new Map<unknown, number>();
  payload.nodes.forEach((node, nodeIndex) => {
    const id: unknown = node.id;
    if (typeof id === 'string') ids.add(id);
    if (!firstIndex.has(id)) firstIndex.set(id, nodeIndex);
    const idDefect = idProblem(id);
    if (idDefect !== undefined) {
      out.push({ ...idDefect, ...(typeof id === 'string' ? { nodeId: id } : {}), nodeIndex });
    }
    const first = firstIndex.get(id) ?? nodeIndex;
    if (first !== nodeIndex) {
      out.push({
        code: 'duplicate-node-id',
        detail: `node ${JSON.stringify(id) ?? String(id)} at index ${nodeIndex} duplicates index ${first}`,
        ...(typeof id === 'string' ? { nodeId: id } : {}),
        nodeIndex,
      });
    }
    const loc = readNodeLocation(node);
    if (loc.state === 'malformed') out.push({ ...loc.defect, nodeIndex });
    const res = readNodeResolution(node);
    if (res.state === 'malformed') out.push({ ...res.defect, nodeIndex });
  });

  payload.edges.forEach((edge, edgeIndex) => {
    const ends = [
      ['source', edge.source as unknown],
      ['target', edge.target as unknown],
    ] as const;
    const bad = new Set<'source' | 'target'>();
    for (const [endpoint, id] of ends) {
      const d = idProblem(id);
      if (d === undefined) continue;
      bad.add(endpoint);
      out.push({ ...d, ...(typeof id === 'string' ? { nodeId: id } : {}), edgeIndex, endpoint });
    }
    for (const [endpoint, id] of ends) {
      if (bad.has(endpoint) || typeof id !== 'string' || ids.has(id)) continue;
      out.push({
        code: 'dangling-edge',
        detail: `edge ${edgeIndex} ${endpoint} ${JSON.stringify(id)} is not a node in the payload`,
        nodeId: id,
        edgeIndex,
        endpoint,
      });
    }
    const res = readEdgeResolution(edge);
    if (res.state === 'malformed') out.push({ ...res.defect, edgeIndex });
  });
  return out;
}

function idProblem(id: unknown): Pick<ModelDefect, 'code' | 'detail'> | undefined {
  if (typeof id !== 'string' || id === '') {
    return {
      code: 'empty-id',
      detail: `id ${JSON.stringify(id) ?? String(id)} is not a non-empty string`,
    };
  }
  if (id.includes('\u0000')) {
    return { code: 'id-contains-separator', detail: `id ${JSON.stringify(id)} contains U+0000` };
  }
  return undefined;
}
