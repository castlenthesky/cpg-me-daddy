import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DockerServerManager } from "../../../src/server/docker.ts";
import { createServerManager } from "../../../src/server/index.ts";
import { RemoteServerManager } from "../../../src/server/remote.ts";
import { SpawnedServerManager } from "../../../src/server/spawned.ts";
import { isServerError } from "../../../src/server/types.ts";
import { reservedClosedPort, startFakeRedis } from "./fixture-server.ts";

describe("createServerManager", () => {
  test("builds the implementation named by engine.db.mode", () => {
    expect(createServerManager({ mode: "spawned" })).toBeInstanceOf(SpawnedServerManager);
    expect(createServerManager({ mode: "docker" })).toBeInstanceOf(DockerServerManager);
    expect(createServerManager({ mode: "remote" })).toBeInstanceOf(RemoteServerManager);
  });

  test("each manager reports its own mode", () => {
    expect(createServerManager({ mode: "spawned" }).mode).toBe("spawned");
    expect(createServerManager({ mode: "docker" }).mode).toBe("docker");
    expect(createServerManager({ mode: "remote" }).mode).toBe("remote");
  });
});

describe("RemoteServerManager", () => {
  test("connects to a reachable server and owns no lifecycle", async () => {
    const fake = await startFakeRedis();
    try {
      const handle = await new RemoteServerManager({ port: fake.port }).start();
      expect(handle.mode).toBe("remote");
      expect(handle.endpoint).toEqual({ host: "127.0.0.1", port: fake.port });
      expect(handle.modulePath).toBeUndefined();
      // stop() must be a no-op: the server is not ours.
      await handle.stop();
      expect(await new RemoteServerManager({ port: fake.port }).start()).toBeDefined();
    } finally {
      await fake.close();
    }
  });

  test("an unreachable remote fails clearly and fast", async () => {
    const port = await reservedClosedPort();
    const started = Date.now();
    let thrown: unknown;
    try {
      await new RemoteServerManager({ port, connectTimeoutMs: 1_000 }).start();
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("remote_unreachable");
      expect(thrown.message).toContain(String(port));
      expect(thrown.remedy).toContain("engine.db.host");
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("probe:false hands back the endpoint unchecked", async () => {
    const port = await reservedClosedPort();
    const handle = await new RemoteServerManager({ port, probe: false }).start();
    expect(handle.endpoint.port).toBe(port);
  });
});

describe("SpawnedServerManager", () => {
  test("X14(3): Windows is refused with the docker/remote remedy before anything is spawned", async () => {
    const cache = await mkdtemp(join(tmpdir(), "cpg-spawn-"));
    try {
      let thrown: unknown;
      try {
        await new SpawnedServerManager({
          platform: { platform: "win32", arch: "x64" },
          cacheRoot: cache,
          env: {},
        }).start();
      } catch (error) {
        thrown = error;
      }
      expect(isServerError(thrown)).toBe(true);
      if (isServerError(thrown)) {
        expect(thrown.code).toBe("unsupported_platform");
        expect(thrown.message).toContain("Windows");
        expect(thrown.remedy).toContain("falkordb/falkordb:v4.20.4");
      }
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});

describe("DockerServerManager", () => {
  test("a missing docker executable is a clear error, not a hang", async () => {
    let thrown: unknown;
    try {
      await new DockerServerManager({
        dockerPath: "/nonexistent/docker-binary",
        readyTimeoutMs: 500,
      }).start();
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("docker_not_found");
      expect(thrown.remedy).toContain("spawned");
      expect(thrown.remedy).toContain("remote");
    }
  });
});
