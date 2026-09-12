/**
 * The pinned FalkorDB release, and the platform -> asset map (X14(2)).
 *
 * FalkorDB publishes NO standalone server binary. Release v4.20.4 ships 15
 * assets and every one of them is a Redis module (`.so`) or a RAMP package.
 * The spike question "single binary or `redis-server --loadmodule`?" therefore
 * has only one answer: `redis-server --loadmodule`. `SpawnedServerManager`
 * needs a `redis-server` executable that FalkorDB does not ship, which is why
 * `redis.ts` spends so much effort failing clearly when there isn't one.
 *
 * Every sha256 below was produced by downloading the asset from the URL in
 * `assetUrl()` and hashing it locally on 2026-09-11. Sizes are bytes.
 * NEVER add an entry here without downloading and hashing the real file.
 */

import { ServerError } from "./types";

/** The one release the engine is pinned to. Bumping this needs new checksums. */
export const FALKORDB_VERSION = "v4.20.4";

/** The Docker image carrying the same build, used by `DockerServerManager`. */
export const FALKORDB_IMAGE = `falkordb/falkordb:${FALKORDB_VERSION}`;

/** Where the release assets live. Plain HTTPS — product code never shells out to `gh`. */
export const FALKORDB_RELEASE_BASE_URL = `https://github.com/FalkorDB/FalkorDB/releases/download/${FALKORDB_VERSION}`;

/**
 * Keys the engine can auto-detect, plus glibc-variant keys that are reachable
 * only through the `CPG_FALKORDB_PLATFORM` override. The generic `linux-*`
 * assets are the Debian/Ubuntu builds; RHEL and Amazon Linux users whose glibc
 * is too old can pin their own.
 */
export type PlatformKey =
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "linux-x64-rhel8"
  | "linux-x64-rhel9"
  | "linux-x64-amazonlinux2023";

export interface AssetRecord {
  /** Release asset file name. Also the cached file name. */
  readonly asset: string;
  /** Lowercase hex sha256 of the asset, verified by download-and-hash. */
  readonly sha256: string;
  /** Size in bytes. A cheap pre-check before the (much slower) hash. */
  readonly size: number;
  /** True when only `CPG_FALKORDB_PLATFORM` can select this entry. */
  readonly overrideOnly?: boolean;
}

export const FALKORDB_ASSETS: Readonly<Record<PlatformKey, AssetRecord>> = {
  "darwin-arm64": {
    asset: "falkordb-macos-arm64v8.so",
    sha256: "ab329e75abd9e43026e037fe4b3cacdb98a295df4b434b433174927107cd61c3",
    size: 33074168,
  },
  "linux-x64": {
    asset: "falkordb-x64.so",
    sha256: "81ea6b989dc2fd4c9ad905e246018b220b02f0e40c406255f9da4768c1684555",
    size: 50848736,
  },
  "linux-arm64": {
    asset: "falkordb-arm64v8.so",
    sha256: "3af674201bdfce73004effab2f2ede632bd00f04539adde0c4923df33cfb53fa",
    size: 43833584,
  },
  "linux-x64-musl": {
    asset: "falkordb-alpine-x64.so",
    sha256: "b078651f592cd5727693166df77bbd7c482e2944b6b10efdcbb4e4a9d6eb5c83",
    size: 53792824,
  },
  "linux-arm64-musl": {
    asset: "falkordb-alpine-arm64v8.so",
    sha256: "323fe237747c86fd68d04061b06031ab1135df6b43232acf20b44430ec2d60bf",
    size: 44737776,
  },
  "linux-x64-rhel8": {
    asset: "falkordb-rhel8-x64.so",
    sha256: "7b505a4e74788fd448996a51fa3d26c6e33802932cc1bff221177c24774a4a98",
    size: 53167440,
    overrideOnly: true,
  },
  "linux-x64-rhel9": {
    asset: "falkordb-rhel9-x64.so",
    sha256: "70cdd540c2e8c49af8685c0c36d9181acd5120bffa627e9d1da435268d8701c1",
    size: 53658472,
    overrideOnly: true,
  },
  "linux-x64-amazonlinux2023": {
    asset: "falkordb-amazonlinux2023-x64.so",
    sha256: "bdbd65be12fde2bdcf8ddf5ea9149ad7fa33d087ee8516eeac9127320a6bc77b",
    size: 52569000,
    overrideOnly: true,
  },
};

export const PLATFORM_KEYS = Object.keys(FALKORDB_ASSETS) as PlatformKey[];

export function isPlatformKey(value: string): value is PlatformKey {
  return Object.prototype.hasOwnProperty.call(FALKORDB_ASSETS, value);
}

/** Download URL for one asset of the pinned release. */
export function assetUrl(record: AssetRecord, baseUrl: string = FALKORDB_RELEASE_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}/${record.asset}`;
}

/** What the platform probe observed. Injected so the mapping is testable off-host. */
export interface PlatformProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** `process.arch`. */
  readonly arch: string;
  /** True on musl systems (Alpine). See `detectMusl()`. */
  readonly musl?: boolean;
}

const WINDOWS_REMEDY =
  "FalkorDB publishes no Windows build, so `engine.db.mode: spawned` cannot work on Windows. " +
  "Set `engine.db.mode` to `docker` (runs " +
  FALKORDB_IMAGE +
  ") or to `remote` and point `engine.db.host`/`engine.db.port` at a FalkorDB you already run.";

const NO_ASSET_REMEDY =
  "Set `engine.db.mode` to `docker` or `remote`. If a FalkorDB release asset does exist for this " +
  "platform, pin it with CPG_FALKORDB_PLATFORM=<key> (one of: " +
  PLATFORM_KEYS.join(", ") +
  ").";

/**
 * platform/arch -> release asset. Throws `unsupported_platform` rather than
 * guessing: launching the wrong `.so` fails deep inside redis-server with a
 * far worse message than this one.
 */
export function resolvePlatformKey(probe: PlatformProbe): PlatformKey {
  if (probe.platform === "win32") {
    throw new ServerError("unsupported_platform", "Spawned mode is not supported on Windows.", {
      remedy: WINDOWS_REMEDY,
    });
  }
  if (probe.platform === "darwin") {
    if (probe.arch === "arm64") {
      return "darwin-arm64";
    }
    throw new ServerError(
      "unsupported_platform",
      `FalkorDB ${FALKORDB_VERSION} ships no macOS ${probe.arch} module (arm64 only).`,
      { remedy: NO_ASSET_REMEDY },
    );
  }
  if (probe.platform === "linux") {
    const musl = probe.musl === true;
    if (probe.arch === "x64") {
      return musl ? "linux-x64-musl" : "linux-x64";
    }
    if (probe.arch === "arm64") {
      return musl ? "linux-arm64-musl" : "linux-arm64";
    }
    throw new ServerError(
      "unsupported_platform",
      `FalkorDB ${FALKORDB_VERSION} ships no Linux ${probe.arch} module (x64 and arm64 only).`,
      { remedy: NO_ASSET_REMEDY },
    );
  }
  throw new ServerError(
    "unsupported_platform",
    `Unsupported platform '${probe.platform}' for FalkorDB ${FALKORDB_VERSION}.`,
    { remedy: NO_ASSET_REMEDY },
  );
}

/**
 * Resolve the asset for a probe, honouring `CPG_FALKORDB_PLATFORM`. The
 * override is how a RHEL8 or Amazon Linux user reaches an asset auto-detection
 * would never pick.
 *
 * `assets` defaults to the pinned manifest. It is a seam for tests and for
 * validating a version bump — a caller still has to supply a real sha256, so
 * it cannot be used to skip verification.
 */
export function resolveAsset(
  probe: PlatformProbe,
  env: Readonly<Record<string, string | undefined>> = {},
  assets: Readonly<Partial<Record<PlatformKey, AssetRecord>>> = FALKORDB_ASSETS,
): { key: PlatformKey; record: AssetRecord } {
  const override = env.CPG_FALKORDB_PLATFORM?.trim();
  if (override) {
    if (!isPlatformKey(override)) {
      throw new ServerError(
        "unsupported_platform",
        `CPG_FALKORDB_PLATFORM='${override}' is not a known FalkorDB platform key.`,
        { remedy: `Use one of: ${PLATFORM_KEYS.join(", ")}.` },
      );
    }
    return { key: override, record: requireRecord(assets, override) };
  }
  const key = resolvePlatformKey(probe);
  return { key, record: requireRecord(assets, key) };
}

function requireRecord(
  assets: Readonly<Partial<Record<PlatformKey, AssetRecord>>>,
  key: PlatformKey,
): AssetRecord {
  const record = assets[key];
  if (!record) {
    throw new ServerError(
      "unsupported_platform",
      `No pinned FalkorDB asset for platform key '${key}'.`,
      { remedy: NO_ASSET_REMEDY },
    );
  }
  return record;
}
