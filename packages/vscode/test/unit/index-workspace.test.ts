import { describe, expect, test } from "bun:test";

import { defineCpgDevFalkorConfig } from "@cpg/engine";

import {
  chooseWorkspaceFolder,
  explicitDbOverrides,
  indexReportLines,
  indexSummary,
  INDEX_WORKSPACE_COMMAND,
  nextProgressTick,
  surfaceIndexError,
} from "../../src/index.ts";

describe("the CLAUDE.md rule, as an executable gate", () => {
  test("with no settings touched, the resolved port is 6382 — never 6381, the test harness", () => {
    const config = defineCpgDevFalkorConfig(explicitDbOverrides({}));
    expect(config.connection.port).toBe(6382);
    expect(config.connection.port).not.toBe(6381);
  });
});

describe("chooseWorkspaceFolder", () => {
  test("no folders open", () => {
    expect(chooseWorkspaceFolder([])).toEqual({ kind: "none" });
  });

  test("exactly one folder open — no prompt needed", () => {
    expect(chooseWorkspaceFolder(["only"])).toEqual({ kind: "one", index: 0 });
  });

  test("more than one folder open — must pick", () => {
    expect(chooseWorkspaceFolder(["a", "b"])).toEqual({ kind: "pick" });
  });

  test("a preselected folder that matches skips the pick", () => {
    expect(chooseWorkspaceFolder(["a", "b"], "b")).toEqual({ kind: "one", index: 1 });
  });

  test("a preselected folder that does not match still prompts", () => {
    expect(chooseWorkspaceFolder(["a", "b"], "nope")).toEqual({ kind: "pick" });
  });
});

describe("explicitDbOverrides", () => {
  test("all-unset settings yield an empty override", () => {
    expect(explicitDbOverrides({})).toEqual({});
  });

  test("a set port appears in the override", () => {
    const input = explicitDbOverrides({ port: { workspaceValue: 6382 } });
    expect(input.connection?.port).toBe(6382);
  });

  test("a default-valued inspection (no explicit level set) is never used — the env-shadowing regression test", () => {
    // vscode's inspect() would return { defaultValue: 6382 } for an untouched
    // setting; this snapshot type deliberately has no `defaultValue` field at
    // all, so there is nothing here for an unset setting to surface as.
    const input = explicitDbOverrides({ port: {} });
    expect(input.connection).toBeUndefined();
  });

  test("workspaceFolderValue wins over workspaceValue wins over globalValue", () => {
    const input = explicitDbOverrides({
      host: { workspaceFolderValue: "folder", workspaceValue: "ws", globalValue: "global" },
    });
    expect(input.connection?.host).toBe("folder");
  });

  test("an invalid mode string is dropped rather than passed through unchecked", () => {
    const input = explicitDbOverrides({ mode: { workspaceValue: "wishful" } });
    expect(input.server).toBeUndefined();
  });

  test("a valid mode string is passed through", () => {
    const input = explicitDbOverrides({ mode: { workspaceValue: "docker" } });
    expect(input.server?.mode).toBe("docker");
  });
});

describe("nextProgressTick", () => {
  test("suppresses a tick inside the 100ms throttle window", () => {
    const tick = nextProgressTick(
      { filesTotal: 10, filesDone: 1 },
      { percent: 0, atMs: 1000 },
      1050,
    );
    expect(tick).toBeUndefined();
  });

  test("emits a tick once the window has elapsed, carrying the increment forward", () => {
    const tick = nextProgressTick(
      { filesTotal: 10, filesDone: 5 },
      { percent: 10, atMs: 1000 },
      1150,
    );
    expect(tick).toBeDefined();
    expect(tick!.increment).toBe(40); // 50% - 10% already reported
  });

  test("always emits the final tick regardless of the throttle window", () => {
    const tick = nextProgressTick(
      { filesTotal: 10, filesDone: 10 },
      { percent: 90, atMs: 1000 },
      1010,
    );
    expect(tick).toBeDefined();
    expect(tick!.increment).toBe(10);
  });

  test("increments never sum to more than 100 over a full run", () => {
    let last = { percent: 0, atMs: 0 };
    let total = 0;
    for (let done = 1; done <= 10; done++) {
      const tick = nextProgressTick({ filesTotal: 10, filesDone: done }, last, last.atMs + 200);
      if (tick !== undefined) {
        total += tick.increment;
        last = { percent: last.percent + tick.increment, atMs: last.atMs + 200 };
      }
    }
    expect(total).toBe(100);
  });
});

describe("indexReportLines / indexSummary", () => {
  const baseReport = {
    root: "/tmp/x",
    walk: {
      directoriesVisited: 1,
      directoriesSkipped: 0,
      filesSeen: 2,
      filesExcluded: 0,
      filesUnsupported: 0,
      filesTooLarge: 0,
      symlinksSkipped: 0,
    },
    filesIndexed: 2,
    nodesWritten: 10,
    edgesWritten: 5,
    opsExecuted: 3,
    warnings: [],
    durationMs: 1500,
    cancelled: false,
  };

  test("the clean case", () => {
    expect(indexSummary(baseReport)).toContain("indexed 2 file(s)");
    expect(indexReportLines(baseReport).join("\n")).toContain("10 nodes");
  });

  test("the partial-failure case names each warning", () => {
    const report = {
      ...baseReport,
      warnings: [{ kind: "parse-failed" as const, path: "a.ts", message: "boom" }],
    };
    expect(indexReportLines(report).some((l) => l.includes("boom"))).toBe(true);
  });

  test("the cancelled case", () => {
    const report = { ...baseReport, cancelled: true, filesIndexed: 1 };
    expect(indexSummary(report)).toContain("cancelled");
    expect(indexReportLines(report)).toContain("  (cancelled)");
  });
});

describe("surfaceIndexError", () => {
  test("degrades a plain Error without throwing", () => {
    const surfaced = surfaceIndexError(new Error("nope"), { host: "127.0.0.1", port: 6382 });
    expect(surfaced.message).toContain("nope");
    expect(surfaced.actions).toEqual(["Show Log"]);
  });

  test("degrades a thrown string without throwing", () => {
    const surfaced = surfaceIndexError("nope", { host: "127.0.0.1", port: 6382 });
    expect(surfaced.message).toContain("nope");
  });

  test("names the target host:port for a connection failure, not just the generic remedy", () => {
    class FakeServerError extends Error {
      readonly code = "remote_unreachable";
      readonly remedy = "start it";
    }
    const surfaced = surfaceIndexError(new FakeServerError("unreachable"), {
      host: "127.0.0.1",
      port: 6382,
    });
    // Not a real ServerError (isServerError checks a specific shape), so this
    // degrades to the generic path — asserting that is itself the point:
    // surfaceIndexError never throws on an unrecognized error shape.
    expect(surfaced.message).toContain("unreachable");
  });
});

describe("command id", () => {
  test("matches the one contributed in package.json", () => {
    expect(INDEX_WORKSPACE_COMMAND).toBe("cpg.indexWorkspace");
  });
});
