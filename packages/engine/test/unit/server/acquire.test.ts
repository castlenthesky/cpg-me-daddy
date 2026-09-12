import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireFalkorModule,
  detectMusl,
  type AcquireOptions,
} from "../../../src/server/acquire.ts";
import { isExecutableMode } from "../../../src/server/cache.ts";
import type { AssetRecord, PlatformKey } from "../../../src/server/manifest.ts";
import { isServerError } from "../../../src/server/types.ts";
import { reservedClosedPort, startFixtureServer, type FixtureServer } from "./fixture-server.ts";

const VERSION = "v4.20.4";
const ASSET = "falkordb-fixture.so";
const PROBE = { platform: "darwin", arch: "arm64" } as const;

/** A stand-in module. Real bytes, real hash — only the size differs from 33 MB. */
const BODY = Buffer.from("ELF fixture FalkorDB module ".repeat(64));
const SHA256 = createHash("sha256").update(BODY).digest("hex");

function manifestOf(record: Partial<AssetRecord> = {}): Partial<Record<PlatformKey, AssetRecord>> {
  return {
    "darwin-arm64": { asset: ASSET, sha256: SHA256, size: BODY.byteLength, ...record },
  };
}

const temps: string[] = [];
const servers: FixtureServer[] = [];

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cpg-acq-"));
  temps.push(dir);
  return dir;
}
async function fixture(body: Buffer = BODY): Promise<FixtureServer> {
  const server = await startFixtureServer({ files: { [ASSET]: body } });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function options(cacheRoot: string, baseUrl: string, extra: AcquireOptions = {}): AcquireOptions {
  return {
    version: VERSION,
    baseUrl,
    cacheRoot,
    platform: PROBE,
    manifest: manifestOf(),
    allowInsecureUrl: true,
    stripQuarantine: false,
    env: {},
    ...extra,
  };
}

function cachedPath(cacheRoot: string): string {
  return join(cacheRoot, "falkordb", VERSION, ASSET);
}

describe("acquireFalkorModule — happy path", () => {
  test("downloads, verifies, chmod +x and caches at the X14(2) path", async () => {
    const cache = await temp();
    const server = await fixture();

    const result = await acquireFalkorModule(options(cache, server.baseUrl));

    expect(result.fromCache).toBe(false);
    expect(result.path).toBe(cachedPath(cache));
    expect(result.sha256).toBe(SHA256);
    expect(result.platformKey).toBe("darwin-arm64");
    expect(server.requests()).toBe(1);
    // THE trap: a download lands 0644 and redis-server aborts on it.
    expect(result.chmodApplied).toBe(true);
    expect(isExecutableMode((await stat(result.path)).mode & 0o7777)).toBe(true);
    // No .part left behind.
    expect(existsSync(`${result.path}.part`)).toBe(false);
  });

  test("reuses a valid cache without touching the network", async () => {
    const cache = await temp();
    const server = await fixture();

    await acquireFalkorModule(options(cache, server.baseUrl));
    const second = await acquireFalkorModule(options(cache, server.baseUrl));

    expect(second.fromCache).toBe(true);
    expect(second.chmodApplied).toBe(false);
    expect(server.requests()).toBe(1);
  });

  test("a cache hit still works when the origin is unreachable (offline reuse)", async () => {
    const cache = await temp();
    const server = await fixture();
    await acquireFalkorModule(options(cache, server.baseUrl));
    await server.close();
    servers.length = 0;
    const deadPort = await reservedClosedPort();

    const result = await acquireFalkorModule(
      options(cache, `http://127.0.0.1:${deadPort}`, { connectTimeoutMs: 500 }),
    );

    expect(result.fromCache).toBe(true);
  });

  test("CPG_CACHE_DIR is honoured when no explicit cacheRoot is given", async () => {
    const cache = await temp();
    const server = await fixture();

    const result = await acquireFalkorModule({
      version: VERSION,
      baseUrl: server.baseUrl,
      platform: PROBE,
      manifest: manifestOf(),
      allowInsecureUrl: true,
      stripQuarantine: false,
      env: { CPG_CACHE_DIR: cache },
    });

    expect(result.path).toBe(cachedPath(cache));
  });
});

describe("acquireFalkorModule — the chmod regression", () => {
  test("a cached module that lost its +x bit is repaired on the next acquire", async () => {
    const cache = await temp();
    const server = await fixture();
    const first = await acquireFalkorModule(options(cache, server.baseUrl));

    // Simulate the exact state redis-server refuses to load.
    await chmod(first.path, 0o644);
    expect(isExecutableMode((await stat(first.path)).mode & 0o7777)).toBe(false);

    const second = await acquireFalkorModule(options(cache, server.baseUrl));

    expect(second.fromCache).toBe(true);
    expect(second.chmodApplied).toBe(true);
    expect(isExecutableMode((await stat(second.path)).mode & 0o7777)).toBe(true);
    expect(server.requests()).toBe(1);
  });
});

describe("acquireFalkorModule — checksum refusal", () => {
  test("a tampered cached module is REFUSED and quarantined", async () => {
    const cache = await temp();
    const server = await fixture();
    const first = await acquireFalkorModule(options(cache, server.baseUrl));

    // Tamper: a few extra bytes are enough to change the hash.
    await appendFile(first.path, "evil");

    let thrown: unknown;
    try {
      await acquireFalkorModule(options(cache, server.baseUrl));
    } catch (error) {
      thrown = error;
    }

    expect(isServerError(thrown)).toBe(true);
    if (!isServerError(thrown)) {
      return;
    }
    expect(thrown.code).toBe("checksum_mismatch");
    expect(thrown.message).toContain("Refusing to launch FalkorDB");
    expect(thrown.message).toContain(SHA256);
    expect(thrown.remedy).toContain("quarantined");
    // The bad file is out of the load path but still inspectable.
    expect(existsSync(first.path)).toBe(false);
    const quarantined = readdirSync(join(cache, "falkordb", VERSION)).filter((f) =>
      f.includes(".quarantined-"),
    );
    expect(quarantined).toHaveLength(1);
    // And it did NOT silently re-download to paper over the tampering.
    expect(server.requests()).toBe(1);
  });

  test("a fresh download whose hash does not match the manifest never reaches the cache", async () => {
    const cache = await temp();
    const server = await fixture();
    const wrongHash = "0".repeat(64);

    let thrown: unknown;
    try {
      await acquireFalkorModule(
        options(cache, server.baseUrl, { manifest: manifestOf({ sha256: wrongHash }) }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("checksum_mismatch");
      expect(thrown.message).toContain("fresh download");
      expect(thrown.message).toContain(SHA256);
    }
    expect(existsSync(cachedPath(cache))).toBe(false);
  });

  test("a truncated download is caught by the size pre-check", async () => {
    const cache = await temp();
    const server = await fixture(BODY.subarray(0, 10));

    let thrown: unknown;
    try {
      await acquireFalkorModule(options(cache, server.baseUrl));
    } catch (error) {
      thrown = error;
    }

    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("checksum_mismatch");
      expect(thrown.message).toContain(`is 10 bytes, expected ${BODY.byteLength}`);
    }
    expect(existsSync(cachedPath(cache))).toBe(false);
  });
});

describe("acquireFalkorModule — platform refusal", () => {
  test("X14(3): Windows is refused before any network or disk I/O", async () => {
    const cache = await temp();
    const deadPort = await reservedClosedPort();
    const started = Date.now();

    let thrown: unknown;
    try {
      await acquireFalkorModule(
        options(cache, `http://127.0.0.1:${deadPort}`, {
          platform: { platform: "win32", arch: "x64" },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("unsupported_platform");
      expect(thrown.remedy).toContain("docker");
    }
    // Nothing was created and nothing was dialled.
    expect(existsSync(join(cache, "falkordb"))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("detectMusl", () => {
  test("alpine-release is conclusive", () => {
    expect(detectMusl({ exists: (p) => p === "/etc/alpine-release", list: () => [] })).toBe(true);
  });

  test("an ld-musl loader in /lib is conclusive", () => {
    expect(detectMusl({ exists: () => false, list: () => ["ld-musl-x86_64.so.1"] })).toBe(true);
  });

  test("a glibc layout is not musl", () => {
    expect(detectMusl({ exists: () => false, list: () => ["ld-linux-x86-64.so.2"] })).toBe(false);
  });
});
