import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureExecutable,
  fileSize,
  isExecutableMode,
  moduleCacheDir,
  moduleCachePath,
  quarantine,
  type CacheRemedyContext,
} from "../../../src/services/server/cache.ts";
import { testConfig } from "../../support/config.ts";

/** Cache failures quote the host's own cache-dir variable; these tests use the defaults. */
const CONTEXT: CacheRemedyContext = {
  branding: testConfig().branding,
  cacheDirEnvName: testConfig().envNames.cacheDir,
};

const temps: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cpg-cache-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("module cache paths", () => {
  test("the module path is <root>/falkordb/<version>/<asset>", () => {
    expect(moduleCacheDir("/c", "v4.20.4")).toBe("/c/falkordb/v4.20.4");
    expect(moduleCachePath("/c", "v4.20.4", "falkordb-macos-arm64v8.so")).toBe(
      "/c/falkordb/v4.20.4/falkordb-macos-arm64v8.so",
    );
  });
});

describe("ensureExecutable — the 0644 trap", () => {
  test("isExecutableMode reads the owner execute bit", () => {
    expect(isExecutableMode(0o644)).toBe(false);
    expect(isExecutableMode(0o755)).toBe(true);
    expect(isExecutableMode(0o700)).toBe(true);
  });

  test("a 0644 module (exactly how a download lands) is fixed to 0755", async () => {
    const dir = await temp();
    const file = join(dir, "falkordb.so");
    await writeFile(file, "not really a module");
    await chmod(file, 0o644);
    expect(isExecutableMode((await stat(file)).mode & 0o7777)).toBe(false);

    const result = await ensureExecutable(file, CONTEXT);

    expect(result.changed).toBe(true);
    expect(result.mode).toBe(0o755);
    expect(isExecutableMode((await stat(file)).mode & 0o7777)).toBe(true);
  });

  test("an already-executable module is left alone", async () => {
    const dir = await temp();
    const file = join(dir, "falkordb.so");
    await writeFile(file, "x");
    await chmod(file, 0o755);
    const result = await ensureExecutable(file, CONTEXT);
    expect(result.changed).toBe(false);
    expect(result.mode).toBe(0o755);
  });

  test("a missing file fails with a remedy instead of a raw errno", async () => {
    const dir = await temp();
    const promise = ensureExecutable(join(dir, "absent.so"), CONTEXT);
    await expect(promise).rejects.toThrow(/Cannot stat cached FalkorDB module/);
  });
});

describe("quarantine", () => {
  test("moves the bad file aside and leaves the cache path empty", async () => {
    const dir = await temp();
    const file = join(dir, "falkordb.so");
    await writeFile(file, "tampered");
    expect(await fileSize(file)).toBe(8);

    const target = await quarantine(file, () => 1757600000000);

    expect(target).toBe(`${file}.quarantined-1757600000000`);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("fileSize reports undefined for an absent file", async () => {
    const dir = await temp();
    expect(await fileSize(join(dir, "nope"))).toBeUndefined();
  });
});
