/**
 * cpg's FalkorDB branding, and the two live-bug fixes that came with it:
 * `CPG_GRAPH` used to be unreachable (M0.1-thin), and a zero-config
 * `defineCpgFalkorConfig` used to point at 127.0.0.1:6379 — the conventional
 * dev instance CLAUDE.md says never to touch.
 */
import { describe, expect, test } from "bun:test";

import {
  CPG_DEV_ENDPOINT,
  defineCpgDevFalkorConfig,
  defineCpgFalkorConfig,
} from "../../../src/store/falkordb.config.ts";

describe("defineCpgFalkorConfig", () => {
  test('defaults the graph to "cpg"', () => {
    expect(defineCpgFalkorConfig({ env: {} }).connection.graph).toBe("cpg");
  });

  test("CPG_GRAPH now actually takes effect — it used to be dead code", () => {
    const config = defineCpgFalkorConfig({ env: { CPG_GRAPH: "myproj" } });
    expect(config.connection.graph).toBe("myproj");
  });

  test("an explicit connection.graph still wins over CPG_GRAPH", () => {
    const config = defineCpgFalkorConfig({
      env: { CPG_GRAPH: "myproj" },
      connection: { graph: "explicit" },
    });
    expect(config.connection.graph).toBe("explicit");
  });

  test("host/port are untouched by cpg branding — package defaults still apply", () => {
    const config = defineCpgFalkorConfig({ env: {} });
    expect(config.connection.host).toBe("127.0.0.1");
    expect(config.connection.port).toBe(6379);
    expect(config.server.mode).toBe("remote");
  });

  test("CPG_HOST / CPG_PORT / CPG_MODE still work", () => {
    const config = defineCpgFalkorConfig({
      env: { CPG_HOST: "10.0.0.1", CPG_PORT: "9999", CPG_MODE: "docker" },
    });
    expect(config.connection.host).toBe("10.0.0.1");
    expect(config.connection.port).toBe(9999);
    expect(config.server.mode).toBe("docker");
  });
});

describe("CPG_DEV_ENDPOINT", () => {
  test("is not 6379 (falkordb-local, forbidden), 6380 (ast-demo bench) or 6381 (the test harness)", () => {
    expect(CPG_DEV_ENDPOINT.port).not.toBe(6379);
    expect(CPG_DEV_ENDPOINT.port).not.toBe(6380);
    expect(CPG_DEV_ENDPOINT.port).not.toBe(6381);
    expect(CPG_DEV_ENDPOINT.port).toBe(6382);
  });
});

describe("defineCpgDevFalkorConfig", () => {
  test("zero-config resolves to the dev endpoint, never 6379 — the CLAUDE.md rule as a gate", () => {
    const config = defineCpgDevFalkorConfig({ env: {} });
    expect(config.connection.port).toBe(6382);
    expect(config.connection.port).not.toBe(6381);
    expect(config.connection.host).toBe(CPG_DEV_ENDPOINT.host);
    expect(config.server.mode).toBe("remote");
  });

  test('still defaults the graph to "cpg" — the dev defaults don\'t shadow it', () => {
    expect(defineCpgDevFalkorConfig({ env: {} }).connection.graph).toBe("cpg");
  });

  test("CPG_PORT still overrides the dev default", () => {
    const config = defineCpgDevFalkorConfig({ env: { CPG_PORT: "7000" } });
    expect(config.connection.port).toBe(7000);
  });

  test("an explicit connection input still overrides the dev default", () => {
    const config = defineCpgDevFalkorConfig({ connection: { port: 1234 } });
    expect(config.connection.port).toBe(1234);
  });
});
