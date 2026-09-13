/**
 * `defineFalkorConfig` is the package's only reader of the environment, so
 * this file is where "which variable wins?" is pinned down. The cache-root
 * cases used to live in the cache suite; they moved here with the logic.
 */

import { describe, expect, test } from "bun:test";

import { defineFalkorConfig, envNames, DEFAULT_BRANDING } from "../../src/config.ts";

const HOME = "/home/u";

describe("cache root resolution", () => {
  test("the branded cache-dir variable wins over everything", () => {
    const config = defineFalkorConfig({
      env: { FALKORDB_CACHE_DIR: "/tmp/explicit", XDG_CACHE_HOME: "/tmp/xdg" },
      home: HOME,
    });
    expect(config.acquisition.cacheRoot).toBe("/tmp/explicit");
  });

  test("XDG_CACHE_HOME is next, and gets the namespace segment", () => {
    const config = defineFalkorConfig({ env: { XDG_CACHE_HOME: "/tmp/xdg" }, home: HOME });
    expect(config.acquisition.cacheRoot).toBe("/tmp/xdg/falkordb");
  });

  test("the default is ~/.cache/<namespace>", () => {
    expect(defineFalkorConfig({ env: {}, home: HOME }).acquisition.cacheRoot).toBe(
      "/home/u/.cache/falkordb",
    );
  });

  test("a blank value is ignored rather than producing a relative path", () => {
    const config = defineFalkorConfig({ env: { FALKORDB_CACHE_DIR: "   " }, home: HOME });
    expect(config.acquisition.cacheRoot).toBe("/home/u/.cache/falkordb");
  });

  test("the branding's namespace is what lands in the path", () => {
    const config = defineFalkorConfig({
      env: {},
      home: HOME,
      branding: { cacheNamespace: "myapp" },
    });
    expect(config.acquisition.cacheRoot).toBe("/home/u/.cache/myapp");
  });
});

describe("env var naming", () => {
  test("the prefix drives every default name", () => {
    const names = envNames("MYAPP");
    expect(names.cacheDir).toBe("MYAPP_CACHE_DIR");
    expect(names.redisServer).toBe("MYAPP_REDIS_SERVER");
    expect(names.platform).toBe("MYAPP_PLATFORM");
  });

  test("a host can override one name without losing the rest", () => {
    const config = defineFalkorConfig({
      env: { CPG_CACHE_DIR: "/c", CPG_FALKORDB_PLATFORM: "linux-x64-rhel9" },
      home: HOME,
      branding: { envPrefix: "CPG" },
      envNames: { platform: "CPG_FALKORDB_PLATFORM" },
    });
    expect(config.acquisition.cacheRoot).toBe("/c");
    expect(config.acquisition.platformKey).toBe("linux-x64-rhel9");
    expect(config.envNames.redisServer).toBe("CPG_REDIS_SERVER");
  });

  test("the resolved names travel on the config, for remedies to quote", () => {
    const config = defineFalkorConfig({ env: {}, home: HOME, branding: { envPrefix: "MYAPP" } });
    expect(config.envNames.cacheDir).toBe("MYAPP_CACHE_DIR");
  });
});

describe("precedence and validation", () => {
  test("an explicit value beats the environment", () => {
    const config = defineFalkorConfig({
      env: { FALKORDB_HOST: "from-env", FALKORDB_PORT: "1234" },
      home: HOME,
      connection: { host: "explicit" },
    });
    expect(config.connection.host).toBe("explicit");
    expect(config.connection.port).toBe(1234);
  });

  test("remote defaults to 6379; the modes that start a server default to an OS-picked port", () => {
    expect(defineFalkorConfig({ env: {}, home: HOME }).connection.port).toBe(6379);
    expect(
      defineFalkorConfig({ env: {}, home: HOME, server: { mode: "spawned" } }).connection.port,
    ).toBe(0);
    expect(
      defineFalkorConfig({ env: {}, home: HOME, server: { mode: "docker" } }).connection.port,
    ).toBe(0);
  });

  test("an unknown mode is rejected at config time, not at start time", () => {
    expect(() => defineFalkorConfig({ env: { FALKORDB_MODE: "wishful" }, home: HOME })).toThrow(
      /not one of: spawned, remote, docker/,
    );
  });

  test("an unknown platform key is rejected at config time", () => {
    expect(() =>
      defineFalkorConfig({ env: { FALKORDB_PLATFORM: "solaris-sparc" }, home: HOME }),
    ).toThrow(/not a known FalkorDB platform key/);
  });

  test("a non-numeric port is rejected rather than silently becoming NaN", () => {
    expect(() => defineFalkorConfig({ env: { FALKORDB_PORT: "hello" }, home: HOME })).toThrow(
      /is not an integer/,
    );
  });

  test("the release base URL follows an overridden version", () => {
    const config = defineFalkorConfig({ env: {}, home: HOME, acquisition: { version: "v9.9.9" } });
    expect(config.acquisition.releaseBaseUrl).toEndWith("/v9.9.9");
  });

  test("default branding is applied when none is given", () => {
    expect(defineFalkorConfig({ env: {}, home: HOME }).branding).toEqual(DEFAULT_BRANDING);
  });
});

describe("defaults precedence layer", () => {
  test("a host default is used when neither input nor env set a value", () => {
    const config = defineFalkorConfig({
      env: {},
      home: HOME,
      defaults: { connection: { host: "127.0.0.1", port: 6382, graph: "cpg" } },
    });
    expect(config.connection.host).toBe("127.0.0.1");
    expect(config.connection.port).toBe(6382);
    expect(config.connection.graph).toBe("cpg");
  });

  test("the env var still wins over a host default — this is the whole point", () => {
    const config = defineFalkorConfig({
      env: { FALKORDB_PORT: "7000" },
      home: HOME,
      defaults: { connection: { port: 6382 } },
    });
    expect(config.connection.port).toBe(7000);
  });

  test("an explicit input value still wins over both env and a host default", () => {
    const config = defineFalkorConfig({
      env: { FALKORDB_PORT: "7000" },
      home: HOME,
      connection: { port: 9999 },
      defaults: { connection: { port: 6382 } },
    });
    expect(config.connection.port).toBe(9999);
  });

  test("a host default port pre-empts the package's own remote-mode 6379 fallback", () => {
    const config = defineFalkorConfig({
      env: {},
      home: HOME,
      defaults: { connection: { port: 6382 } },
    });
    expect(config.connection.port).toBe(6382);
  });

  test("a host default server.mode is used ahead of the package's remote fallback", () => {
    const config = defineFalkorConfig({
      env: {},
      home: HOME,
      defaults: { server: { mode: "docker" } },
    });
    expect(config.server.mode).toBe("docker");
  });

  test("with no defaults given at all, resolution is unchanged", () => {
    const withDefaults = defineFalkorConfig({ env: {}, home: HOME, defaults: {} });
    const withoutDefaults = defineFalkorConfig({ env: {}, home: HOME });
    expect(withDefaults.connection).toEqual(withoutDefaults.connection);
    expect(withDefaults.server.mode).toEqual(withoutDefaults.server.mode);
  });
});
