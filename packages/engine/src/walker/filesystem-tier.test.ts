// filesystemTier on hand-built walks. The ladder covers real trees; this pins the shapes the ladder
// cannot: the root has no name and no parent edge, and the node data carries both hashes.

import type { WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { filesystemTier } from './filesystem-tier';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}

describe('filesystemTier', () => {
  it('builds DIRECTORY, FILE and HAS_ENTRY from one walk', () => {
    const tier = filesystemTier({
      directories: [
        { path: wp('.'), parent: undefined },
        { path: wp('pkg'), parent: wp('.') },
      ],
      files: [
        {
          path: wp('pkg/m.py'),
          parent: wp('pkg'),
          language: 'python',
          sizeBytes: 3,
          revision_id: 'ab',
        },
      ],
    });
    expect(tier.nodes).toEqual([
      { id: 'dir:.', type: 'DIRECTORY', data: { path: '.' } },
      { id: 'dir:pkg', type: 'DIRECTORY', name: 'pkg', data: { path: 'pkg', name: 'pkg' } },
      {
        id: 'file:pkg/m.py',
        type: 'FILE',
        name: 'm.py',
        data: {
          path: 'pkg/m.py',
          name: 'm.py',
          language: 'python',
          content_hash: 'ab',
          revision_id: 'ab',
        },
      },
    ]);
    expect(tier.edges).toEqual([
      { source: 'dir:.', target: 'dir:pkg', type: 'HAS_ENTRY' },
      { source: 'dir:pkg', target: 'file:pkg/m.py', type: 'HAS_ENTRY' },
    ]);
  });

  it('escapes ids through makeNodeId (a `:` in a path is %3A)', () => {
    const tier = filesystemTier({
      directories: [{ path: wp('.'), parent: undefined }],
      files: [
        { path: wp('a:b.txt'), parent: wp('.'), language: null, sizeBytes: 0, revision_id: 'e' },
      ],
    });
    expect(tier.nodes.map((n) => n.id)).toEqual(['dir:.', 'file:a%3Ab.txt']);
    expect(tier.edges).toEqual([{ source: 'dir:.', target: 'file:a%3Ab.txt', type: 'HAS_ENTRY' }]);
  });
});
