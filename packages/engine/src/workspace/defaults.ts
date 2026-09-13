/**
 * Default walk scope (M0.2). Overridable per call; see `WalkOptions`.
 *
 * Deliberately generic: these apply to any workspace `cpg index` points at,
 * not just this repo. That is why there is no root-anchored exclude for a
 * bare `src/` — this repo's own legacy pre-monorepo tree happens to be one,
 * but `src/` at a workspace root is an extremely common, legitimate source
 * directory (this engine's own test fixtures include one). Excluding it here
 * would silently break indexing for a large fraction of real codebases.
 * Excluding *this* repo's legacy `src/`/`test/`/`scripts/`/`media/`/
 * `resources/` trees is this repo's own concern, supplied as explicit
 * `--exclude` flags when indexing cpg-me-daddy itself — not an engine
 * default (see the verification commands in the M0.11-lite PR).
 */

/** Everything, by default — the real filtering is `DEFAULT_EXCLUDES` plus `grammarForPath`. */
export const DEFAULT_INCLUDES: readonly string[] = ["**/*"];

export const DEFAULT_EXCLUDES: readonly string[] = [
  // Dependency and version-control trees.
  "**/node_modules/**",
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",

  // Python virtualenvs and caches.
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.tox/**",
  "**/site-packages/**",

  // Build output and tool caches, wherever they occur.
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.cache/**",
  "**/.tmp/**",
  "**/.vscode-test/**",

  // Sibling git worktrees of this very repo (gitignored; each is a full
  // duplicate checkout). Without this, indexing mid-parallel-work produces
  // duplicate MODULEs at phantom paths.
  "**/.claude/worktrees/**",

  // Generated or non-source files the current adapters don't consume yet.
  // `.d.ts` is a deliberate decision, not an omission: the TS adapter does
  // not emit type-only declarations, so a `.d.ts` file would yield a
  // near-empty MODULE.
  "**/*.min.js",
  "**/*.d.ts",
];

/** Files larger than this are skipped and counted in `WalkStats.filesTooLarge`. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
