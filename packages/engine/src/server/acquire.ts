/**
 * The acquisition pipeline (X14(2)) — the security-critical path of this unit.
 *
 *   platform -> asset -> cache hit? -> verify sha256 -> chmod +x -> ready
 *                     \-> download to .part -> verify sha256 -> chmod +x -> rename in
 *
 * Two invariants hold no matter which branch runs:
 *   1. NOTHING is ever handed back — or moved into the cache — before its
 *      sha256 matches the pinned manifest. A mismatch is a refusal, never a
 *      silent retry; the bad file is quarantined, not deleted, so it can be
 *      inspected.
 *   2. The cached file is always chmod +x. A downloaded `.so` arrives 0644 and
 *      redis-server aborts on it. See `ensureExecutable()`.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { access, rename, rm } from "node:fs/promises";
import { platform as osPlatform, arch as osArch } from "node:os";

import {
  ensureCacheDir,
  ensureExecutable,
  fileSize,
  moduleCacheDir,
  moduleCachePath,
  quarantine,
} from "./cache";
import { verifyChecksum } from "./checksum";
import { downloadToFile, type DownloadOptions } from "./download";
import {
  assetUrl,
  FALKORDB_RELEASE_BASE_URL,
  FALKORDB_VERSION,
  resolveAsset,
  type AssetRecord,
  type PlatformKey,
  type PlatformProbe,
} from "./manifest";
import { ServerError } from "./types";

export interface AcquireOptions extends DownloadOptions {
  /** Release to acquire. Defaults to the pinned `FALKORDB_VERSION`. */
  version?: string;
  /** Release asset base URL. Overridden in tests to point at a local fixture server. */
  baseUrl?: string;
  /** Overrides the whole cache root resolution (CPG_CACHE_DIR etc.). */
  cacheRoot?: string;
  home?: string;
  platform?: PlatformProbe;
  /** Overrides the pinned asset table. A seam for tests and version bumps. */
  manifest?: Readonly<Partial<Record<PlatformKey, AssetRecord>>>;
  /** Best-effort `com.apple.quarantine` strip on macOS. Default true. */
  stripQuarantine?: boolean;
  log?: (message: string) => void;
}

export interface AcquiredModule {
  /** Absolute path of the verified, executable module. */
  readonly path: string;
  readonly asset: string;
  readonly platformKey: PlatformKey;
  readonly version: string;
  readonly sha256: string;
  /** True when the cache was reused and nothing was downloaded. */
  readonly fromCache: boolean;
  /** True when `chmod +x` actually had to fix the file. */
  readonly chmodApplied: boolean;
}

/** Detect musl (Alpine) so the right Linux asset is chosen. */
export function detectMusl(
  fsProbe: { exists: (p: string) => boolean; list: (p: string) => string[] } = {
    exists: (p) => existsSync(p),
    list: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
  },
): boolean {
  if (fsProbe.exists("/etc/alpine-release")) {
    return true;
  }
  return fsProbe.list("/lib").some((entry) => entry.startsWith("ld-musl-"));
}

/** The running host, as the manifest wants to see it. */
export function currentPlatformProbe(): PlatformProbe {
  const platform = osPlatform();
  return {
    platform,
    arch: osArch(),
    musl: platform === "linux" ? detectMusl() : false,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * macOS Gatekeeper hedge. The verified run on darwin-arm64 showed only a
 * `com.apple.provenance` xattr and the module loaded fine, so this is
 * defensive, not observed-necessary: a browser-origin copy could carry
 * `com.apple.quarantine`. Best effort — every failure is ignored.
 */
async function stripMacQuarantine(path: string): Promise<void> {
  if (osPlatform() !== "darwin") {
    return;
  }
  await new Promise<void>((resolve) => {
    execFile("/usr/bin/xattr", ["-d", "com.apple.quarantine", path], () => resolve());
  });
}

function mismatchError(
  record: AssetRecord,
  actual: string,
  where: string,
  quarantinedAt?: string,
): ServerError {
  const detail = quarantinedAt ? `The rejected file was moved to ${quarantinedAt}` : undefined;
  return new ServerError(
    "checksum_mismatch",
    `SHA-256 mismatch for ${record.asset} (${where}): expected ${record.sha256}, got ${actual}. ` +
      "Refusing to launch FalkorDB.",
    {
      remedy:
        "cpg will not load a module it cannot verify against its pinned manifest. The bad file has " +
        "been quarantined; re-run to fetch a clean copy. If it keeps failing, your download is being " +
        "modified in transit (check your proxy/TLS interception) or the pinned checksum is wrong for " +
        "the configured release.",
      detail,
    },
  );
}

/**
 * Ensure a verified, executable FalkorDB module is on disk and return its path.
 * Safe to call on every start: a valid cache short-circuits the download.
 */
export async function acquireFalkorModule(options: AcquireOptions = {}): Promise<AcquiredModule> {
  const env = options.env ?? process.env;
  const version = options.version ?? FALKORDB_VERSION;
  const probe = options.platform ?? currentPlatformProbe();
  const log = options.log ?? ((): void => {});

  // Throws `unsupported_platform` (with the X14(3) Windows message) before any I/O.
  const { key, record } = resolveAsset(probe, env, options.manifest);

  const cacheOptions = options.cacheRoot
    ? { env: { CPG_CACHE_DIR: options.cacheRoot }, home: options.home }
    : { env, home: options.home };
  const dir = moduleCacheDir(version, cacheOptions);
  const path = moduleCachePath(version, record.asset, cacheOptions);

  if (await exists(path)) {
    const size = await fileSize(path);
    const result = await verifyChecksum(path, record.sha256);
    if (result.ok) {
      const chmodResult = await ensureExecutable(path);
      log(`FalkorDB ${version} module reused from cache: ${path}`);
      return {
        path,
        asset: record.asset,
        platformKey: key,
        version,
        sha256: record.sha256,
        fromCache: true,
        chmodApplied: chmodResult.changed,
      };
    }
    // A cached file that no longer matches is corrupt or tampered with. Refuse
    // and quarantine; do NOT quietly re-download, which would hide the event.
    const quarantinedAt = await quarantine(path);
    log(`FalkorDB module at ${path} failed verification (${size ?? "?"} bytes); quarantined.`);
    throw mismatchError(record, result.actual, "cached copy", quarantinedAt);
  }

  await ensureCacheDir(dir);

  const url = assetUrl(record, options.baseUrl ?? FALKORDB_RELEASE_BASE_URL);
  const partPath = `${path}.part`;
  await rm(partPath, { force: true });
  log(`Downloading FalkorDB ${version} module (${record.asset}) from ${url}`);

  const { bytes } = await downloadToFile(url, partPath, options);

  if (bytes !== record.size) {
    await rm(partPath, { force: true });
    throw new ServerError(
      "checksum_mismatch",
      `Downloaded ${record.asset} is ${bytes} bytes, expected ${record.size}. Refusing to launch FalkorDB.`,
      {
        remedy:
          "The download was truncated or served by something other than the pinned FalkorDB " +
          "release. Retry; if it persists, check any proxy or captive portal between you and GitHub.",
      },
    );
  }

  const verified = await verifyChecksum(partPath, record.sha256);
  if (!verified.ok) {
    // Never let an unverified byte reach the cache path the launcher reads.
    const quarantinedAt = await quarantine(partPath);
    throw mismatchError(record, verified.actual, "fresh download", quarantinedAt);
  }

  if (options.stripQuarantine !== false) {
    await stripMacQuarantine(partPath);
  }
  const chmodResult = await ensureExecutable(partPath);
  await rename(partPath, path);
  // Re-assert after the rename; cheap, and the mode is the whole ballgame.
  const finalChmod = await ensureExecutable(path);
  log(`FalkorDB ${version} module verified and cached at ${path}`);

  return {
    path,
    asset: record.asset,
    platformKey: key,
    version,
    sha256: record.sha256,
    fromCache: false,
    chmodApplied: chmodResult.changed || finalChmod.changed,
  };
}
