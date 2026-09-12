/**
 * The F3 gate, end to end, against the real FalkorDB release.
 *
 * NETWORK-GATED. This suite is excluded from `bun run test:unit` (which only
 * walks `test/unit`) and additionally refuses to run unless
 * `CPG_INTEGRATION_FALKORDB=1` is set, because the first run downloads a 33 MB
 * `.so` and every run spawns a real redis-server. CI stays fast and offline;
 * a human runs `bun run test:integration` on a machine with redis-server.
 *
 * It uses the REAL default cache (`~/.cache/cpg/falkordb/<version>/`, or
 * `CPG_CACHE_DIR`), so a second run exercises the cache-reuse path for free.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineFalkorConfig, type FalkorConfigInput } from "../../src/config.ts";
import { acquireFalkorModule } from "../../src/services/server/acquire.ts";
import { isExecutableMode } from "../../src/services/server/cache.ts";
import {
  FALKORDB_ASSETS,
  FALKORDB_VERSION,
  resolvePlatformKey,
} from "../../src/services/server/manifest.ts";
import { findFreePort, findRedisServer, sendCommand } from "../../src/services/server/redis.ts";
import { SpawnedServerManager } from "../../src/services/server/spawned.ts";
import { isServerError } from "../../src/services/server/types.ts";

/**
 * The real gate runs against the developer's actual cache and environment, so
 * unlike the unit suites it does NOT stub `env` — it resolves config exactly
 * the way a product run would.
 */
function realConfig(input: FalkorConfigInput = {}) {
  return defineFalkorConfig({ ...input, server: { mode: "spawned", ...input.server } });
}

const LOG = { log: (m: string) => console.log(`  ${m}`) };
const RESOLUTION = {
  branding: realConfig().branding,
  platformEnvName: realConfig().envNames.platform,
};

const ENABLED = process.env.CPG_INTEGRATION_FALKORDB === "1";
const suite = ENABLED ? describe : describe.skip;

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cpg-int-"));
  temps.push(dir);
  return dir;
}

suite("F3 gate: real acquisition and spawn", () => {
  test("acquires the pinned module: download or cache reuse, verified and +x", async () => {
    const result = await acquireFalkorModule({ config: realConfig(), ...LOG });

    const key = resolvePlatformKey({ platform: process.platform, arch: process.arch }, RESOLUTION);
    expect(result.asset).toBe(FALKORDB_ASSETS[key].asset);
    expect(result.version).toBe(FALKORDB_VERSION);
    expect(result.path).toContain(join("falkordb", FALKORDB_VERSION));
    const mode = (await stat(result.path)).mode & 0o7777;
    expect(isExecutableMode(mode)).toBe(true);
    expect((await stat(result.path)).size).toBe(FALKORDB_ASSETS[key].size);
    console.log(
      `  acquired ${result.asset} fromCache=${result.fromCache} mode=0${mode.toString(8)}`,
    );
  }, 600_000);

  test("spawns on an ephemeral port, answers PING, loads the graph module, shuts down cleanly", async () => {
    const manager = new SpawnedServerManager(realConfig(), LOG);
    const handle = await manager.start();
    try {
      expect(handle.endpoint.port).toBeGreaterThan(1024);
      // Must not collide with the developer's own Redis instances.
      expect([6379, 6380, 6381]).not.toContain(handle.endpoint.port);

      const pong = await sendCommand(["PING"], handle.endpoint);
      expect(pong).toBe("+PONG");

      const modules = await sendCommand(["MODULE", "LIST"], handle.endpoint);
      expect(modules.startsWith("-")).toBe(false);

      const query = await sendCommand(
        ["GRAPH.QUERY", "cpg_f3_gate", "CREATE (:Probe {name:'f3'}) RETURN 1"],
        handle.endpoint,
      );
      expect(query.startsWith("-")).toBe(false);

      await sendCommand(["GRAPH.DELETE", "cpg_f3_gate"], handle.endpoint);
    } finally {
      await handle.stop();
    }

    // After a clean SHUTDOWN NOSAVE the port is free again.
    await new Promise((resolve) => setTimeout(resolve, 250));
    let stillUp = true;
    try {
      await sendCommand(["PING"], { ...handle.endpoint, timeoutMs: 500 });
    } catch {
      stillUp = false;
    }
    expect(stillUp).toBe(false);
  }, 120_000);

  test("the 0644 trap: redis-server refuses a non-executable module, and acquire repairs it", async () => {
    const acquired = await acquireFalkorModule({ config: realConfig() });
    const scratch = await temp();
    const copy = join(scratch, acquired.asset);
    await copyFile(acquired.path, copy);
    await chmod(copy, 0o644);

    // 1. Prove the trap is real: redis-server aborts on the 0644 module.
    const redisServer = findRedisServer({
      branding: realConfig().branding,
      redisServerEnvName: realConfig().envNames.redisServer,
      explicitPath: realConfig().server.redisServerPath,
    });
    const port = await findFreePort();
    const child = spawn(redisServer, ["--port", String(port), "--loadmodule", copy], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout?.on("data", (c: Buffer) => {
      log += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      log += c.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", (exitCode) => resolve(exitCode));
    });
    console.log(
      `  redis-server exit=${code} log tail:\n${log.trim().split("\n").slice(-4).join("\n")}`,
    );
    expect(code).not.toBe(0);
    expect(log).toContain("does not have execute permissions");

    // 2. Prove acquire fixes it: chmod the real cached file down, re-acquire.
    await chmod(acquired.path, 0o644);
    expect(isExecutableMode((await stat(acquired.path)).mode & 0o7777)).toBe(false);
    const repaired = await acquireFalkorModule({ config: realConfig() });
    expect(repaired.fromCache).toBe(true);
    expect(repaired.chmodApplied).toBe(true);
    expect(isExecutableMode((await stat(repaired.path)).mode & 0o7777)).toBe(true);

    // 3. And the repaired module actually launches.
    const handle = await new SpawnedServerManager(realConfig()).start();
    try {
      expect(await sendCommand(["PING"], handle.endpoint)).toBe("+PONG");
    } finally {
      await handle.stop();
    }
  }, 300_000);

  test("a tampered cached module is REFUSED, with the real file on disk", async () => {
    const cacheRoot = await temp();
    const acquired = await acquireFalkorModule({ config: realConfig() });
    const key = resolvePlatformKey({ platform: process.platform, arch: process.arch }, RESOLUTION);
    const target = join(cacheRoot, "falkordb", FALKORDB_VERSION, FALKORDB_ASSETS[key].asset);
    await Bun.write(target, await readFile(acquired.path));
    // Flip the tail of a genuine 33 MB module.
    const bytes = await readFile(target);
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
    await writeFile(target, bytes);

    let thrown: unknown;
    try {
      await new SpawnedServerManager(realConfig({ acquisition: { cacheRoot } })).start();
    } catch (error) {
      thrown = error;
    }

    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      console.log(`  refusal:\n${thrown.toString()}`);
      expect(thrown.code).toBe("checksum_mismatch");
      expect(thrown.message).toContain("Refusing to launch FalkorDB");
    }
    expect(existsSync(target)).toBe(false);
  }, 300_000);
});
