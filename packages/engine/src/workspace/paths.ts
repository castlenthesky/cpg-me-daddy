/**
 * Shared path helpers for the filesystem tier (DIRECTORY/FILE/HAS_ENTRY).
 * One place for the `"."` root convention and basename/ancestor logic, so the
 * walker, the indexer's filesystem phase, and the watcher's normalizer never
 * grow three slightly different implementations of the same string math.
 */

/** The `DIRECTORY.path` of the workspace root itself. A walked relative path can never collide with it. */
export const ROOT_DIR_PATH = ".";

/** The basename of a workspace-relative POSIX path, e.g. `"a/b/c.ts"` -> `"c.ts"`. */
export function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** The parent `DIRECTORY.path` of a workspace-relative path — `ROOT_DIR_PATH` for a top-level entry. */
export function parentDirPath(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? ROOT_DIR_PATH : relPath.slice(0, idx);
}

/**
 * Every ancestor DIRECTORY.path of `relPath`, root-first, e.g. `"a/b/c.ts"`
 * -> `[".", "a", "a/b"]`. Used by the watcher: a full workspace walk already
 * emits every ancestor directory, but a single created-file event does not,
 * so `MERGE`ing this list first guarantees the destination's parent chain
 * exists before the file's own HAS_ENTRY link is written.
 */
export function ancestorDirPaths(relPath: string): readonly string[] {
  const segments = relPath.split("/").slice(0, -1);
  const out: string[] = [ROOT_DIR_PATH];
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    out.push(current);
  }
  return out;
}
