// The filesystem tier (DIRECTORY, FILE, HAS_ENTRY) built from one walk. Properties live in `data`
// under their schema names (04-schema.yaml); `name` is also the node's display name.

import type { GraphEdge, GraphNode } from '@cpg/model';
import type { WalkResult } from './walker';

export interface FilesystemTier {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export function filesystemTier(_walk: Pick<WalkResult, 'files' | 'directories'>): FilesystemTier {
  // SEAT: U2a.2a
  throw new Error('SEAT: filesystemTier is not built yet (U2a.2a)');
}
