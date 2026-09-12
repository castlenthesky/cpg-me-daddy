import { describe, expect, test } from "bun:test";

import {
  COMMON_REDIS_DIRS,
  encodeCommand,
  findFreePort,
  findRedisServer,
  ping,
  waitForReady,
} from "../../../src/server/redis.ts";
import { isServerError } from "../../../src/server/types.ts";
import { reservedClosedPort, startFakeRedis } from "./fixture-server.ts";

const onlyAt =
  (...paths: string[]) =>
  (candidate: string): boolean =>
    paths.includes(candidate);

describe("findRedisServer", () => {
  test("CPG_REDIS_SERVER takes precedence over PATH", () => {
    const found = findRedisServer({
      env: { CPG_REDIS_SERVER: "/custom/redis-server", PATH: "/usr/bin" },
      isExecutable: onlyAt("/custom/redis-server", "/usr/bin/redis-server"),
    });
    expect(found).toBe("/custom/redis-server");
  });

  test("a CPG_REDIS_SERVER that is not executable is a clear error, not a fallback", () => {
    let thrown: unknown;
    try {
      findRedisServer({
        env: { CPG_REDIS_SERVER: "/custom/redis-server", PATH: "/usr/bin" },
        isExecutable: onlyAt("/usr/bin/redis-server"),
      });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("redis_server_not_found");
      expect(thrown.message).toContain("/custom/redis-server");
    }
  });

  test("PATH is searched in order", () => {
    const found = findRedisServer({
      env: { PATH: "/a:/b" },
      isExecutable: onlyAt("/b/redis-server"),
    });
    expect(found).toBe("/b/redis-server");
  });

  test("the common install prefixes are searched when PATH misses", () => {
    const found = findRedisServer({
      env: { PATH: "/nowhere" },
      isExecutable: onlyAt("/opt/homebrew/bin/redis-server"),
    });
    expect(found).toBe("/opt/homebrew/bin/redis-server");
    expect(COMMON_REDIS_DIRS).toContain("/opt/homebrew/bin");
  });

  test("X14(4): no redis-server produces the actionable FalkorDB-ships-a-module message", () => {
    let thrown: unknown;
    try {
      findRedisServer({ env: { PATH: "/nowhere" }, isExecutable: () => false });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (!isServerError(thrown)) {
      return;
    }
    expect(thrown.code).toBe("redis_server_not_found");
    // The whole point of SP11's finding: explain WHY a Redis is needed at all.
    expect(thrown.remedy).toContain("Redis module");
    expect(thrown.remedy).toContain("brew install redis");
    expect(thrown.remedy).toContain("CPG_REDIS_SERVER");
    expect(thrown.remedy).toContain("docker");
    expect(thrown.remedy).toContain("remote");
    // And it must render as one readable block for a CLI or MCP status payload.
    expect(thrown.toString()).toContain("[redis_server_not_found]");
  });
});

describe("RESP encoding", () => {
  test("encodes a multi-word command", () => {
    expect(encodeCommand(["SHUTDOWN", "NOSAVE"])).toBe("*2\r\n$8\r\nSHUTDOWN\r\n$6\r\nNOSAVE\r\n");
  });

  test("counts bytes, not characters", () => {
    expect(encodeCommand(["GRAPH.QUERY", "café"])).toContain("$5\r\ncafé\r\n");
  });
});

describe("ping", () => {
  test("true against something that answers +PONG", async () => {
    const fake = await startFakeRedis();
    try {
      expect(await ping({ port: fake.port, timeoutMs: 1_000 })).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("false, not a hang, against a closed port", async () => {
    const port = await reservedClosedPort();
    const started = Date.now();
    expect(await ping({ port, timeoutMs: 1_000 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("waitForReady", () => {
  test("returns as soon as the server answers", async () => {
    const fake = await startFakeRedis();
    try {
      await waitForReady({ port: fake.port, readyTimeoutMs: 2_000, intervalMs: 25 });
    } finally {
      await fake.close();
    }
  });

  test("a dead process short-circuits the wait and quotes the server log", async () => {
    const port = await reservedClosedPort();
    const started = Date.now();
    let thrown: unknown;
    try {
      await waitForReady({
        port,
        readyTimeoutMs: 30_000,
        intervalMs: 10,
        isAlive: () => false,
        onGiveUp: () =>
          "Module /cache/falkordb.so failed to load: It does not have execute permissions.",
      });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("server_start_failed");
      expect(thrown.detail).toContain("execute permissions");
      expect(thrown.remedy).toContain("execute permission");
    }
    // Not a 30 s hang: the exit is noticed immediately.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("X14(4): an unresponsive server hits the deadline with a clear error", async () => {
    const port = await reservedClosedPort();
    let thrown: unknown;
    try {
      await waitForReady({ port, readyTimeoutMs: 300, intervalMs: 25, timeoutMs: 100 });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("server_not_ready");
      expect(thrown.message).toContain("did not answer PING");
      expect(thrown.remedy).toContain("engine.db.port");
    }
  });
});

describe("findFreePort", () => {
  test("returns a bindable port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(await ping({ port, timeoutMs: 250 })).toBe(false);
  });
});
