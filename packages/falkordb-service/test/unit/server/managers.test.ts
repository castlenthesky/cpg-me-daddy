import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DockerServerManager } from "../../../src/services/server/docker.ts";
import { createServerManager, ServerService } from "../../../src/services/server/index.ts";
import { RemoteServerManager } from "../../../src/services/server/remote.ts";
import { SpawnedServerManager } from "../../../src/services/server/spawned.ts";
import { isServerError } from "../../../src/services/server/types.ts";
import { testConfig } from "../../support/config.ts";
import { reservedClosedPort, startFakeRedis } from "./fixture-server.ts";

/** Managers take the whole resolved config now, not their own options bag. */
const remote = (port: number, server: Record<string, unknown> = {}) =>
  testConfig({ server: { mode: "remote", ...server }, connection: { port } });

describe("createServerManager", () => {
  test("builds the implementation named by the configured mode", () => {
    expect(createServerManager(testConfig({ server: { mode: "spawned" } }))).toBeInstanceOf(
      SpawnedServerManager,
    );
    expect(createServerManager(testConfig({ server: { mode: "docker" } }))).toBeInstanceOf(
      DockerServerManager,
    );
    expect(createServerManager(testConfig({ server: { mode: "remote" } }))).toBeInstanceOf(
      RemoteServerManager,
    );
  });

  test("each manager reports its own mode", () => {
    expect(createServerManager(testConfig({ server: { mode: "spawned" } })).mode).toBe("spawned");
    expect(createServerManager(testConfig({ server: { mode: "docker" } })).mode).toBe("docker");
    expect(createServerManager(testConfig({ server: { mode: "remote" } })).mode).toBe("remote");
  });
});

describe("RemoteServerManager", () => {
  test("connects to a reachable server and owns no lifecycle", async () => {
    const fake = await startFakeRedis();
    try {
      const handle = await new RemoteServerManager(remote(fake.port)).start();
      expect(handle.mode).toBe("remote");
      expect(handle.endpoint).toEqual({ host: "127.0.0.1", port: fake.port });
      expect(handle.modulePath).toBeUndefined();
      // stop() must be a no-op: the server is not ours.
      await handle.stop();
      expect(await new RemoteServerManager(remote(fake.port)).start()).toBeDefined();
    } finally {
      await fake.close();
    }
  });

  test("an unreachable remote fails clearly and fast", async () => {
    const port = await reservedClosedPort();
    const started = Date.now();
    let thrown: unknown;
    try {
      await new RemoteServerManager(remote(port, { connectTimeoutMs: 1_000 })).start();
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("remote_unreachable");
      expect(thrown.message).toContain(String(port));
      // The remedy names whatever the host calls its host setting.
      expect(thrown.remedy).toContain(testConfig().branding.hostSetting);
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the remedy uses the host's own setting names", async () => {
    const port = await reservedClosedPort();
    const config = testConfig({
      server: { mode: "remote", connectTimeoutMs: 500 },
      connection: { port },
      branding: {
        productName: "cpg",
        hostSetting: "`engine.db.host`",
        portSetting: "`engine.db.port`",
        modeSetting: "`engine.db.mode`",
      },
    });
    let thrown: unknown;
    try {
      await new RemoteServerManager(config).start();
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.remedy).toContain("engine.db.host");
      expect(thrown.remedy).toContain("engine.db.mode");
    }
  });

  test("probe:false hands back the endpoint unchecked", async () => {
    const port = await reservedClosedPort();
    const handle = await new RemoteServerManager(remote(port, { probe: false })).start();
    expect(handle.endpoint.port).toBe(port);
  });
});

describe("ServerService", () => {
  test("start is memoized and stop is idempotent", async () => {
    const fake = await startFakeRedis();
    try {
      const service = new ServerService(remote(fake.port));
      expect(service.endpoint).toBeUndefined();
      const first = await service.start();
      const second = await service.start();
      expect(second).toBe(first);
      expect(service.endpoint).toEqual({ host: "127.0.0.1", port: fake.port });
      await service.stop();
      await service.stop();
      expect(service.endpoint).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});

describe("SpawnedServerManager", () => {
  test("Windows is refused with the docker/remote remedy before anything is spawned", async () => {
    const cache = await mkdtemp(join(tmpdir(), "cpg-spawn-"));
    try {
      const config = testConfig({
        server: { mode: "spawned" },
        acquisition: { cacheRoot: cache },
      });
      let thrown: unknown;
      try {
        await new SpawnedServerManager(config, {
          platform: { platform: "win32", arch: "x64" },
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
    const config = testConfig({
      server: { mode: "docker", dockerPath: "/nonexistent/docker-binary", readyTimeoutMs: 500 },
      connection: { port: 0 },
    });
    let thrown: unknown;
    try {
      await new DockerServerManager(config).start();
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
