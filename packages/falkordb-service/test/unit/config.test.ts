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
