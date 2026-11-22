// The walker's glob dialect, ported from 27361a3:packages/engine/src/workspace/glob.ts. A small,
// hand-compiled subset, so an excluded directory is pruned BEFORE the walker descends into it.
//
//   **          zero or more path segments
//   *           any run of characters within one segment (never crosses `/`)
//   ?           exactly one character within one segment
//   leading /   anchors to the workspace root; otherwise the pattern matches at any depth
//   trailing /  directory-only
// No braces, extglobs or `!` negation.

/** Matches a workspace-relative POSIX path against a compiled pattern set. */
export interface PathMatcher {
  /** For a directory, both `path` and `path/` are tried, so `x/**` prunes `x` itself. */
  test(path: string, isDirectory: boolean): boolean;
}

/** Compiles `patterns` once. */
export function compileMatcher(_patterns: readonly string[]): PathMatcher {
  // SEAT: U2a.2a
  throw new Error('SEAT: compileMatcher is not built yet (U2a.2a)');
}
