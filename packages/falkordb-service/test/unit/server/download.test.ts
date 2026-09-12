import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadToFile,
  isProxyBypassed,
  resolveProxy,
} from "../../../src/services/server/download.ts";
import { isServerError } from "../../../src/services/server/types.ts";
import { testConfig } from "../../support/config.ts";
import { reservedClosedPort, startFixtureServer } from "./fixture-server.ts";

/** downloadToFile now names the host's cache variable in its offline remedy. */
const BRANDING = {
  branding: testConfig().branding,
  cacheDirEnvName: testConfig().envNames.cacheDir,
};

const temps: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cpg-dl-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("proxy resolution", () => {
  test("https uses HTTPS_PROXY, falling back to HTTP_PROXY", () => {
    expect(resolveProxy("https://github.com/x", { HTTPS_PROXY: "http://p:3128" })).toBe(
      "http://p:3128",
    );
    expect(resolveProxy("https://github.com/x", { HTTP_PROXY: "http://p:8080" })).toBe(
      "http://p:8080",
    );
  });

  test("lowercase wins over uppercase, as curl does", () => {
    expect(
      resolveProxy("https://github.com/x", {
        https_proxy: "http://lower:1",
        HTTPS_PROXY: "http://upper:2",
      }),
    ).toBe("http://lower:1");
  });

  test("NO_PROXY suppresses the proxy", () => {
    const env = { HTTPS_PROXY: "http://p:3128", NO_PROXY: "github.com" };
    expect(resolveProxy("https://github.com/x", env)).toBeUndefined();
    expect(resolveProxy("https://objects.githubusercontent.com/x", env)).toBe("http://p:3128");
  });

  test("NO_PROXY matches subdomains and the wildcard", () => {
    expect(isProxyBypassed("api.github.com", ".github.com")).toBe(true);
    expect(isProxyBypassed("github.com", ".github.com")).toBe(true);
    expect(isProxyBypassed("notgithub.com", ".github.com")).toBe(false);
    expect(isProxyBypassed("anything.example", "*")).toBe(true);
  });

  test("no proxy configured means no proxy", () => {
    expect(resolveProxy("https://github.com/x", {})).toBeUndefined();
  });
});

describe("downloadToFile", () => {
  test("refuses plain http in product configuration", async () => {
    const dir = await temp();
    let thrown: unknown;
    try {
      await downloadToFile("http://example.com/x.so", join(dir, "x.so"), BRANDING);
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("download_failed");
      expect(thrown.message).toContain("Refusing to download");
      expect(thrown.remedy).toContain("HTTPS");
    }
  });

  test("writes the body to disk", async () => {
    const body = Buffer.from("fake module bytes");
    const fixture = await startFixtureServer({ files: { "m.so": body } });
    const dir = await temp();
    const dest = join(dir, "m.so");
    try {
      const result = await downloadToFile(`${fixture.baseUrl}/m.so`, dest, {
        ...BRANDING,
        allowInsecureUrl: true,
      });
      expect(result.bytes).toBe(body.byteLength);
      expect(await readFile(dest)).toEqual(body);
    } finally {
      await fixture.close();
    }
  });

  test("an HTTP error is reported with an actionable remedy, not swallowed", async () => {
    const fixture = await startFixtureServer({ files: {} });
    const dir = await temp();
    let thrown: unknown;
    try {
      await downloadToFile(`${fixture.baseUrl}/missing.so`, join(dir, "m.so"), {
        ...BRANDING,
        allowInsecureUrl: true,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await fixture.close();
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("download_failed");
      expect(thrown.message).toContain("HTTP 404");
      // The remedy names whatever the host calls its mode setting.
      expect(thrown.remedy).toContain(testConfig().branding.modeSetting);
      expect(thrown.remedy).toContain(testConfig().envNames.cacheDir);
    }
  });

  test("X14(4) offline: an unreachable origin fails fast and clearly", async () => {
    const port = await reservedClosedPort();
    const dir = await temp();
    const started = Date.now();
    let thrown: unknown;
    try {
      await downloadToFile(`http://127.0.0.1:${port}/m.so`, join(dir, "m.so"), {
        ...BRANDING,
        allowInsecureUrl: true,
        connectTimeoutMs: 5_000,
      });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - started;
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("download_failed");
      expect(thrown.message).toContain("Could not reach");
      expect(thrown.remedy).toContain("docker");
    }
    // Refused, not hung: nowhere near the 5 s ceiling.
    expect(elapsed).toBeLessThan(2_000);
  });

  test("X14(4) hang: a stalled body hits the watchdog instead of blocking forever", async () => {
    const fixture = await startFixtureServer({ files: {}, blackholes: ["stall.so"] });
    const dir = await temp();
    const dest = join(dir, "stall.so");
    const started = Date.now();
    let thrown: unknown;
    try {
      await downloadToFile(`${fixture.baseUrl}/stall.so`, dest, {
        ...BRANDING,
        allowInsecureUrl: true,
        connectTimeoutMs: 2_000,
        stallTimeoutMs: 300,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await fixture.close();
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.code).toBe("download_failed");
      expect(thrown.message).toMatch(/stalled|Timed out/);
    }
    expect(Date.now() - started).toBeLessThan(3_000);
    // A partial file must never be left where a later run could trust it.
    expect(existsSync(dest)).toBe(false);
  });

  test("a proxy in the environment is named in the failure message", async () => {
    const port = await reservedClosedPort();
    const dir = await temp();
    let thrown: unknown;
    try {
      await downloadToFile(`http://127.0.0.1:${port}/m.so`, join(dir, "m.so"), {
        ...BRANDING,
        allowInsecureUrl: true,
        connectTimeoutMs: 1_000,
        env: { HTTP_PROXY: "http://proxy.invalid:3128" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(isServerError(thrown)).toBe(true);
    if (isServerError(thrown)) {
      expect(thrown.message).toContain("proxy: http://proxy.invalid:3128");
    }
  });
});
