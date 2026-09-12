import { describe, expect, test } from "bun:test";

import {
  assetUrl,
  FALKORDB_ASSETS,
  FALKORDB_IMAGE,
  releaseBaseUrl,
  FALKORDB_VERSION,
  isPlatformKey,
  PLATFORM_KEYS,
  resolveAsset,
  resolvePlatformKey,
} from "../../../src/services/server/manifest.ts";
import { isServerError } from "../../../src/services/server/types.ts";
import { testConfig } from "../../support/config.ts";

/** resolveAsset/resolvePlatformKey take their remedy wording from the host. */
const RESOLUTION = {
  branding: testConfig().branding,
  platformEnvName: testConfig().envNames.platform,
};

const HEX64 = /^[0-9a-f]{64}$/;

describe("pinned manifest", () => {
  test("every asset carries a real lowercase sha256 and a positive size", () => {
    for (const key of PLATFORM_KEYS) {
      const record = FALKORDB_ASSETS[key];
      expect(record.sha256).toMatch(HEX64);
      expect(record.size).toBeGreaterThan(1_000_000);
      expect(record.asset.endsWith(".so")).toBe(true);
    }
  });

  test("asset names and checksums are unique", () => {
    const assets = PLATFORM_KEYS.map((k) => FALKORDB_ASSETS[k].asset);
    const hashes = PLATFORM_KEYS.map((k) => FALKORDB_ASSETS[k].sha256);
    expect(new Set(assets).size).toBe(assets.length);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("the darwin-arm64 entry matches the hash verified against the real release", () => {
    // Downloaded from the URL below and hashed locally on 2026-09-11.
    expect(FALKORDB_ASSETS["darwin-arm64"]).toEqual({
      asset: "falkordb-macos-arm64v8.so",
      sha256: "ab329e75abd9e43026e037fe4b3cacdb98a295df4b434b433174927107cd61c3",
      size: 33074168,
    });
  });

  test("the release URL and the docker image name the same pinned version", () => {
    expect(FALKORDB_VERSION).toBe("v4.20.4");
    expect(releaseBaseUrl()).toContain(FALKORDB_VERSION);
    expect(FALKORDB_IMAGE).toBe(`falkordb/falkordb:${FALKORDB_VERSION}`);
    expect(assetUrl(FALKORDB_ASSETS["darwin-arm64"])).toBe(
      "https://github.com/FalkorDB/FalkorDB/releases/download/v4.20.4/falkordb-macos-arm64v8.so",
    );
  });

  test("isPlatformKey rejects unknown keys", () => {
    expect(isPlatformKey("darwin-arm64")).toBe(true);
    expect(isPlatformKey("darwin-x64")).toBe(false);
  });
});

describe("resolvePlatformKey", () => {
  test("maps the platforms FalkorDB actually publishes for", () => {
    expect(resolvePlatformKey({ platform: "darwin", arch: "arm64" }, RESOLUTION)).toBe(
      "darwin-arm64",
    );
    expect(resolvePlatformKey({ platform: "linux", arch: "x64" }, RESOLUTION)).toBe("linux-x64");
    expect(resolvePlatformKey({ platform: "linux", arch: "arm64" }, RESOLUTION)).toBe(
      "linux-arm64",
    );
    expect(resolvePlatformKey({ platform: "linux", arch: "x64", musl: true }, RESOLUTION)).toBe(
      "linux-x64-musl",
    );
    expect(resolvePlatformKey({ platform: "linux", arch: "arm64", musl: true }, RESOLUTION)).toBe(
      "linux-arm64-musl",
    );
  });

  test("Windows is refused and pointed at docker/remote", () => {
    let thrown: unknown;
    try {
      resolvePlatformKey({ platform: "win32", arch: "x64" }, RESOLUTION);
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (!isServerError(thrown)) {
      return;
    }
    expect(thrown.code).toBe("unsupported_platform");
    expect(thrown.message).toContain("Windows");
    expect(thrown.remedy).toContain("docker");
    expect(thrown.remedy).toContain("remote");
    // The remedy must name the image so the user can act without reading docs.
    expect(thrown.remedy).toContain(FALKORDB_IMAGE);
  });

  test("macOS x64 has no published asset and says so", () => {
    expect(() => resolvePlatformKey({ platform: "darwin", arch: "x64" }, RESOLUTION)).toThrow(
      /no macOS x64/,
    );
  });

  test("unknown arch and unknown platform are refused, never guessed", () => {
    expect(() => resolvePlatformKey({ platform: "linux", arch: "riscv64" }, RESOLUTION)).toThrow(
      /no Linux riscv64/,
    );
    expect(() => resolvePlatformKey({ platform: "sunos", arch: "x64" }, RESOLUTION)).toThrow(
      /Unsupported platform 'sunos'/,
    );
  });
});

describe("resolveAsset", () => {
  const probe = { platform: "linux", arch: "x64" } as const;

  // The override used to be read from the environment here. It is now parsed
  // and validated by defineFalkorConfig and arrives as a plain key, so the
  // "unknown key" and "blank value" cases live in test/unit/config.test.ts.
  test("an explicit platform key reaches the override-only distro assets", () => {
    const resolved = resolveAsset(probe, { ...RESOLUTION, platformKey: "linux-x64-rhel9" });
    expect(resolved.key).toBe("linux-x64-rhel9");
    expect(resolved.record.asset).toBe("falkordb-rhel9-x64.so");
    expect(resolved.record.overrideOnly).toBe(true);
  });

  test("no override falls through to auto-detection", () => {
    expect(resolveAsset(probe, RESOLUTION).key).toBe("linux-x64");
  });

  test("a key with no pinned asset is refused with the list of valid keys", () => {
    let thrown: unknown;
    try {
      resolveAsset(probe, { ...RESOLUTION, platformKey: "linux-x64-rhel9", assets: {} });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("unsupported_platform");
      expect(thrown.remedy).toContain("linux-x64-musl");
    }
  });

  test("the remedy names the host's own platform variable, not a hard-coded one", () => {
    let thrown: unknown;
    try {
      resolveAsset(probe, {
        branding: { ...RESOLUTION.branding, productName: "myapp" },
        platformEnvName: "MYAPP_PLATFORM",
        platformKey: "linux-x64-rhel9",
        assets: {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown) && thrown.remedy).toContain("MYAPP_PLATFORM");
  });
});
