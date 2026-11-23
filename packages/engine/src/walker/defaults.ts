// The default walk scope (ported from 27361a3:packages/engine/src/workspace/defaults.ts). Generic on
// purpose: these apply to any workspace `cpg index` points at. A bare `src/` is never excluded.

/** Everything; the real filtering is DEFAULT_EXCLUDES. */
export const DEFAULT_INCLUDES: readonly string[] = ['**/*'];

export const DEFAULT_EXCLUDES: readonly string[] = [
  // Dependency and version-control trees.
  '**/node_modules/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  // Python virtualenvs and caches.
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.ruff_cache/**',
  '**/.tox/**',
  '**/site-packages/**',
  // Build output and tool caches, wherever they occur.
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.cache/**',
  '**/.tmp/**',
  '**/.turbo/**',
  '**/.vscode-test/**',
  // Sibling git worktrees (each a full duplicate checkout).
  '**/.claude/worktrees/**',
  // Generated or declaration-only files: a .d.ts would yield a near-empty MODULE.
  '**/*.min.js',
  '**/*.d.ts',
];

/** Files larger than this are skipped and counted in `WalkStats.filesTooLarge`. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
