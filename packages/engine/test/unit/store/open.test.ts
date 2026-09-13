/**
 * `assertNotTestHarness` + `openCpgStore` — the guard that stops real data
 * (or a schema bootstrap) from landing on the integration test harness, and
 * the wiring from a resolved config to a connected store. DB-free: `remote`
 * mode with `probe: false` skips the PING check, and `deps.connect` is
 * injected so no socket is ever opened.
 */
import { describe, expect, test } from "bun:test";

import type { FalkorClient, FalkorConfig } from "falkordb-service";
import { defineFalkorConfig } from "falkordb-service";

import { assertNotTestHarness, openCpgStore, TEST_HARNESS_PORT } from "../../../src/store/open.ts";

function config(overrides: Parameters<typeof defineFalkorConfig>[0] = {}): FalkorConfig {
  return defineFalkorConfig({ env: {}, ...overrides });
}

function fakeClient(): FalkorClient {
  return {
    graphName: "cpg",
    // openCpgStore materializes the graph key with a `RETURN 1` write
    // before anything else — the fake must answer it.
    query: async () => ({ data: [], wallMs: 0, serverMs: 0, raw: [] }),
    close: async () => {},
  } as unknown as FalkorClient;
}

describe("assertNotTestHarness", () => {
  test("refuses the harness port", () => {
    expect(() => assertNotTestHarness(config({ connection: { port: TEST_HARNESS_PORT } }))).toThrow(
      /integration test harness/,
    );
  });

  test("refuses a cpg_test_-prefixed graph regardless of port", () => {
    expect(() =>
      assertNotTestHarness(config({ connection: { port: 6382, graph: "cpg_test_whatever" } })),
    ).toThrow(/reserved for the integration test harness/);
  });

  test("allows a normal dev target", () => {
    expect(() =>
      assertNotTestHarness(config({ connection: { port: 6382, graph: "cpg" } })),
    ).not.toThrow();
  });
});

describe("openCpgStore", () => {
  test("refuses the harness before ever starting a server", async () => {
    await expect(openCpgStore(config({ connection: { port: TEST_HARNESS_PORT } }))).rejects.toThrow(
      /integration test harness/,
    );
  });

  test("connects via the injected deps, skipping bootstrap when asked", async () => {
    const opened = await openCpgStore(
      config({ connection: { port: 6382 }, server: { mode: "remote", probe: false } }),
      { bootstrap: false, deps: { connect: async () => fakeClient() } },
    );

    expect(opened.store).toBeDefined();
    expect(opened.graph).toBeDefined();
    expect(opened.bootstrapReport).toBeUndefined();
    await opened.close();
  });

  test("closes the connection if bootstrap throws, rather than leaking it", async () => {
    let closed = false;
    await expect(
      openCpgStore(
        config({ connection: { port: 6382 }, server: { mode: "remote", probe: false } }),
        {
          deps: {
            connect: async () =>
              ({
                graphName: "cpg",
                close: async () => {
                  closed = true;
                },
              }) as unknown as FalkorClient,
          },
        },
      ),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  });
});
