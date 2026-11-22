// The filesystem tier (DIRECTORY, FILE, HAS_ENTRY) built from one walk. Properties live in `data`
// under their schema names (04-schema.yaml); `name` is also the node's display name. A DIRECTORY's
// status is filesystem-owned and starts 'ready'; FILE.status is code-owned and is not set here.

import { makeNodeId, type GraphEdge, type GraphNode, type WorkspacePath } from '@cpg/model';
import type { WalkResult } from './walker';

export interface FilesystemTier {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

function basename(path: WorkspacePath): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function filesystemTier(walk: Pick<WalkResult, 'files' | 'directories'>): FilesystemTier {
  // REAL
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const dir of walk.directories) {
    const id = makeNodeId({ form: 'directory', path: dir.path });
    // The root's basename is its path, '.': a machine-independent name for a golden-included key.
    const name = basename(dir.path);
    nodes.push({ id, type: 'DIRECTORY', name, data: { path: dir.path, name, status: 'ready' } });
    if (dir.parent !== undefined) {
      edges.push({
        source: makeNodeId({ form: 'directory', path: dir.parent }),
        target: id,
        type: 'HAS_ENTRY',
      });
    }
  }

  for (const file of walk.files) {
    const id = makeNodeId({ form: 'file', path: file.path });
    const name = basename(file.path);
    nodes.push({
      id,
      type: 'FILE',
      name,
      data: {
        path: file.path,
        name,
        language: file.language,
        content_hash: file.revision_id,
        revision_id: file.revision_id,
      },
    });
    edges.push({
      source: makeNodeId({ form: 'directory', path: file.parent }),
      target: id,
      type: 'HAS_ENTRY',
    });
  }

  return { nodes, edges };
}
