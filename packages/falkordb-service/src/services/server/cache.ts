/**
 * The user-level module cache: `<cacheRoot>/falkordb/<version>/<asset>`,
 * shared across workspaces.
 *
 * Resolving `cacheRoot` itself — the env var, `XDG_CACHE_HOME`, the `~/.cache`
 * fallback — belongs to `config.ts`. By the time anything here runs, the root
 * is a plain absolute path and this module does no environment lookup at all.
 */

import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { FalkorBranding } from "../../config";
import { cacheChmodRemedy, cacheUnreadableRemedy, cacheWriteRemedy } from "./remedies";
import { ServerError } from "./types";

/** Mode the cached module must end up with. See `ensureExecutable()`. */
export const MODULE_MODE = 0o755;

/** Directory holding every asset of one pinned FalkorDB version. */
export function moduleCacheDir(cacheRoot: string, version: string): string {
  return join(cacheRoot, "falkordb", version);
}

/** Absolute path of one cached module. */
export function moduleCachePath(cacheRoot: string, version: string, asset: string): string {
  return join(moduleCacheDir(cacheRoot, version), asset);
}

/** What the chmod and mkdir failures need in order to produce a useful remedy. */
export interface CacheRemedyContext {
  readonly branding: FalkorBranding;
  /** Env var name quoted in remedies, e.g. `"FALKORDB_CACHE_DIR"`. */
  readonly cacheDirEnvName: string;
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
export async function ensureExecutable(
  path: string,
  context: CacheRemedyContext,
): Promise<{ changed: boolean; mode: number }> {
  let before: number;
  try {
    before = (await stat(path)).mode & 0o7777;
  } catch (cause) {
    throw new ServerError("cache_write_failed", `Cannot stat cached FalkorDB module: ${path}`, {
      remedy: cacheUnreadableRemedy(context.branding),
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
      { remedy: cacheChmodRemedy(path, context.cacheDirEnvName), cause },
    );
  }
  return { changed: true, mode: MODULE_MODE };
}

/** Create the version directory, failing with a remedy rather than a raw errno. */
export async function ensureCacheDir(dir: string, context: CacheRemedyContext): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new ServerError("cache_write_failed", `Cannot create the cache directory: ${dir}`, {
      remedy: cacheWriteRemedy(context.cacheDirEnvName),
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
