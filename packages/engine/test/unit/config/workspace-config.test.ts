/** M0.1-thin: resolve includes/excludes and a DB target, nothing more. */
import { describe, expect, test } from "bun:test";

import { defineCpgConfig } from "../../../src/config/workspace-config.ts";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES } from "../../../src/workspace/defaults.ts";

describe("defineCpgConfig", () => {
  test("defaults root to an absolute cwd, includes/excludes to the workspace defaults", () => {
    const config = defineCpgConfig({ root: "/tmp/somewhere", env: {} });
    expect(config.root).toBe("/tmp/somewhere");
    expect(config.walk.include).toEqual(DEFAULT_INCLUDES);
    expect(config.walk.exclude).toEqual(DEFAULT_EXCLUDES);
  });

  test("exclude replaces the defaults entirely", () => {
    const config = defineCpgConfig({ exclude: ["**/only-this/**"], env: {} });
    expect(config.walk.exclude).toEqual(["**/only-this/**"]);
  });

  test("excludeExtra appends to the defaults without replacing them", () => {
    const config = defineCpgConfig({ excludeExtra: ["/src/**"], env: {} });
    expect(config.walk.exclude).toEqual([...DEFAULT_EXCLUDES, "/src/**"]);
  });

  test("excludeExtra appends to an explicit exclude, not the defaults, when both are given", () => {
    const config = defineCpgConfig({
      exclude: ["**/only-this/**"],
      excludeExtra: ["/src/**"],
      env: {},
    });
    expect(config.walk.exclude).toEqual(["**/only-this/**", "/src/**"]);
  });

  test("the DB target defaults to the cpg dev instance, never the test harness or 6379", () => {
    const config = defineCpgConfig({ env: {} });
    expect(config.falkor.connection.port).toBe(6382);
  });

  test("CPG_PORT still overrides the DB target's default", () => {
    const config = defineCpgConfig({ env: { CPG_PORT: "7000" } });
    expect(config.falkor.connection.port).toBe(7000);
  });

  test("an explicit db input overrides the DB target's default", () => {
    const config = defineCpgConfig({
      db: { connection: { port: 1234, graph: "custom" } },
      env: {},
    });
    expect(config.falkor.connection.port).toBe(1234);
    expect(config.falkor.connection.graph).toBe("custom");
  });

  describe("the default graph key", () => {
    test("is derived per-workspace root, never the flat 'cpg' constant", () => {
      const a = defineCpgConfig({ root: "/tmp/workspace-a", env: {} });
      const b = defineCpgConfig({ root: "/tmp/workspace-b", env: {} });
      expect(a.falkor.connection.graph).toMatch(/^cpg_[0-9a-f]{12}$/);
      expect(a.falkor.connection.graph).not.toBe(b.falkor.connection.graph);
    });

    test("is stable for the same root", () => {
      const first = defineCpgConfig({ root: "/tmp/same-workspace", env: {} });
      const second = defineCpgConfig({ root: "/tmp/same-workspace", env: {} });
      expect(first.falkor.connection.graph).toBe(second.falkor.connection.graph);
    });

    test("CPG_GRAPH still overrides the derived default", () => {
      const config = defineCpgConfig({ root: "/tmp/workspace-a", env: { CPG_GRAPH: "my_graph" } });
      expect(config.falkor.connection.graph).toBe("my_graph");
    });

    test("an explicit --graph (db.connection.graph) still overrides the derived default", () => {
      const config = defineCpgConfig({
        root: "/tmp/workspace-a",
        db: { connection: { graph: "explicit" } },
        env: {},
      });
      expect(config.falkor.connection.graph).toBe("explicit");
    });
  });
});
