// INV-3 at the type level: the all-empty delta is unrepresentable; each single arm is not.

import type { WorkspacePath } from '@cpg/model';
import type { DeliverableDelta } from './contract';

declare const file: WorkspacePath;
const base = { seq: 0, file, revision_id: 'r', producer: 'code' } as const;

// @ts-expect-error the all-empty delta is not a DeliverableDelta
export const empty: DeliverableDelta = {
  ...base,
  addedNodes: [],
  addedEdges: [],
  removedNodeIds: [],
};

export const edgeOnly: DeliverableDelta = {
  ...base,
  addedNodes: [],
  addedEdges: [{ source: 'a', target: 'b' }],
  removedNodeIds: [],
};
export const removalOnly: DeliverableDelta = {
  ...base,
  addedNodes: [],
  addedEdges: [],
  removedNodeIds: ['a'],
};
