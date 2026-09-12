/**
 * The user-level module cache: `~/.cache/cpg/falkordb/<version>/<asset>` (X14(2)),
 * shared across workspaces, overridable with `CPG_CACHE_DIR`.
 */

import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ServerError } from "./types";

/** Mode the cached module must end up with. See `ensureExecutable()`. */
export const MODULE_MODE = 0o755;

export interface CachePathsOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

/**
 * Root of the cpg cache. Precedence: `CPG_CACHE_DIR`, then `XDG_CACHE_HOME/cpg`,
 * then `~/.cache/cpg`.
 */
export function resolveCacheRoot(options: CachePathsOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.CPG_CACHE_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) {
    return join(xdg, "cpg");
  }
  return join(options.home ?? homedir(), ".cache", "cpg");
}

/** Directory holding every asset of one pinned FalkorDB version. */
export function moduleCacheDir(version: string, options: CachePathsOptions = {}): string {
  return join(resolveCacheRoot(options), "falkordb", version);
}

/** Absolute path of one cached module. */
export function moduleCachePath(
  version: string,
  asset: string,
  options: CachePathsOptions = {},
): string {
  return join(moduleCacheDir(version, options), asset);
}

/** True when the mode bits let the owner execute — what redis-server demands. */
export function isExecutableMode(mode: number): boolean {
  return (mode & 0o100) !== 0;
}

/**
 * THE trap this unit exists to prevent.
 *
 * A downloaded `.so` lands at mode 0644 and redis-server refuses it outright:
 *   `Module <path> failed to load: It does not have execute permissions.`
 *   `... server aborting`
 *
 * So the cached module is chmod'ed unconditionally — the call is idempotent and
 * costs nothing, and skipping it costs a hard startup abort. Returns whether
 * the file actually needed fixing, which is what the regression test asserts.
 */
export async function ensureExecutable(path: string): Promise<{ changed: boolean; mode: number }> {
  let before: number;
  try {
    before = (await stat(path)).mode & 0o7777;
  } catch (cause) {
    throw new ServerError("cache_write_failed", `Cannot stat cached FalkorDB module: ${path}`, {
      remedy: "Check the cache directory is readable, or delete it and let cpg download again.",
      cause,
    });
  }
  if (isExecutableMode(before)) {
    return { changed: false, mode: before };
  }
  try {
    await chmod(path, MODULE_MODE);
  } catch (cause) {
    throw new ServerError(
      "cache_write_failed",
      `Cannot chmod +x the cached FalkorDB module: ${path}`,
      {
        remedy:
          "redis-server refuses to load a module without execute permission. Fix the file mode " +
          `manually (chmod +x '${path}') or choose a writable CPG_CACHE_DIR.`,
        cause,
      },
    );
  }
  return { changed: true, mode: MODULE_MODE };
}

/** Create the version directory, failing with a remedy rather than a raw errno. */
export async function ensureCacheDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new ServerError("cache_write_failed", `Cannot create the cpg cache directory: ${dir}`, {
      remedy: "Point CPG_CACHE_DIR at a writable directory.",
      cause,
    });
  }
}

/**
 * Move a file that failed verification out of the way instead of deleting it,
 * so a tampered or truncated artefact can still be inspected. The cache path is
 * left empty, so the next run downloads cleanly.
 */
export async function quarantine(path: string, now: () => number = Date.now): Promise<string> {
  const target = `${path}.quarantined-${now()}`;
  await rename(path, target);
  return target;
}

/** Size in bytes, or `undefined` when the file is absent. */
export async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}
