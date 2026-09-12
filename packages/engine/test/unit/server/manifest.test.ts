import { describe, expect, test } from "bun:test";

import {
  assetUrl,
  FALKORDB_ASSETS,
  FALKORDB_IMAGE,
  FALKORDB_RELEASE_BASE_URL,
  FALKORDB_VERSION,
  isPlatformKey,
  PLATFORM_KEYS,
  resolveAsset,
  resolvePlatformKey,
} from "../../../src/server/manifest.ts";
import { isServerError } from "../../../src/server/types.ts";

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
    expect(FALKORDB_RELEASE_BASE_URL).toContain(FALKORDB_VERSION);
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
    expect(resolvePlatformKey({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(resolvePlatformKey({ platform: "linux", arch: "x64" })).toBe("linux-x64");
    expect(resolvePlatformKey({ platform: "linux", arch: "arm64" })).toBe("linux-arm64");
    expect(resolvePlatformKey({ platform: "linux", arch: "x64", musl: true })).toBe(
      "linux-x64-musl",
    );
    expect(resolvePlatformKey({ platform: "linux", arch: "arm64", musl: true })).toBe(
      "linux-arm64-musl",
    );
  });

  test("X14(3): Windows is refused and pointed at docker/remote", () => {
    let thrown: unknown;
    try {
      resolvePlatformKey({ platform: "win32", arch: "x64" });
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
    expect(() => resolvePlatformKey({ platform: "darwin", arch: "x64" })).toThrow(/no macOS x64/);
  });

  test("unknown arch and unknown platform are refused, never guessed", () => {
    expect(() => resolvePlatformKey({ platform: "linux", arch: "riscv64" })).toThrow(
      /no Linux riscv64/,
    );
    expect(() => resolvePlatformKey({ platform: "sunos", arch: "x64" })).toThrow(
      /Unsupported platform 'sunos'/,
    );
  });
});

describe("resolveAsset", () => {
  const probe = { platform: "linux", arch: "x64" } as const;

  test("CPG_FALKORDB_PLATFORM reaches the override-only distro assets", () => {
    const resolved = resolveAsset(probe, { CPG_FALKORDB_PLATFORM: "linux-x64-rhel9" });
    expect(resolved.key).toBe("linux-x64-rhel9");
    expect(resolved.record.asset).toBe("falkordb-rhel9-x64.so");
    expect(resolved.record.overrideOnly).toBe(true);
  });

  test("an unknown override is refused with the list of valid keys", () => {
    let thrown: unknown;
    try {
      resolveAsset(probe, { CPG_FALKORDB_PLATFORM: "linux-ppc64" });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("unsupported_platform");
      expect(thrown.remedy).toContain("linux-x64-musl");
    }
  });

  test("an empty override falls through to auto-detection", () => {
    expect(resolveAsset(probe, { CPG_FALKORDB_PLATFORM: "  " }).key).toBe("linux-x64");
  });
});
