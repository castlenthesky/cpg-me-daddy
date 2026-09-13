/**
 * Materializes a plain `{path: contents}` object into a real directory tree
 * under the OS tmp dir, for walker/hasher tests.
 *
 * Required, not merely convenient: a checked-in `node_modules/` or `dist/`
 * fixture is matched by the repo's own `.gitignore` and would simply not
 * commit. Building the tree at runtime is the only way to exercise those
 * exclusions hermetically.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

/** A tree spec: keys are POSIX-style relative paths, values are file contents. */
export type TreeSpec = Readonly<Record<string, string>>;

export interface TmpWorkspace {
  readonly root: string;
  /** Removes the entire tree. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** Writes `spec` under a fresh `mkdtemp` directory and returns its root. */
export async function makeTmpWorkspace(spec: TreeSpec): Promise<TmpWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "cpg-walker-test-"));
  await Promise.all(
    Object.entries(spec).map(async ([relPath, contents]) => {
      const absPath = join(root, ...relPath.split("/"));
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, contents);
    }),
  );
  return {
    root,
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Adds a symlink at `linkRelPath` pointing at `targetRelPath`, both relative to `root`. */
export async function addSymlink(
  root: string,
  linkRelPath: string,
  targetRelPath: string,
): Promise<void> {
  const linkAbs = join(root, ...linkRelPath.split("/"));
  const targetAbs = join(root, ...targetRelPath.split("/"));
  await mkdir(dirname(linkAbs), { recursive: true });
  await symlink(targetAbs, linkAbs);
}

// Re-exported so tests can assert POSIX-normalized output regardless of the
// platform they run on, without importing "node:path" themselves.
export const PATH_SEP = sep;
