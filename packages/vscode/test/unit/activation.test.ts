import { describe, expect, test } from "bun:test";

import {
  activationSummary,
  EXTENSION_VERSION,
  LOG_CHANNEL_NAME,
  SHOW_LOG_COMMAND,
} from "../../src/index.ts";

describe("activationSummary", () => {
  test("names the extension and the engine it is linked against", () => {
    const lines = activationSummary({ workspaceFolders: [] });
    expect(lines[0]).toContain(`@cpg/vscode@${EXTENSION_VERSION}`);
    expect(lines[0]).toContain("@cpg/engine@");
  });

  test("reports no workspace folder when none are open", () => {
    const lines = activationSummary({ workspaceFolders: [] });
    expect(lines.join("\n")).toContain("no workspace folder open");
  });

  test("names each open workspace folder", () => {
    const lines = activationSummary({ workspaceFolders: ["cpg-me-daddy"] });
    expect(lines.join("\n")).toContain("1 workspace folder(s): cpg-me-daddy");
  });

  test("resolves the db config without connecting", () => {
    const lines = activationSummary({ workspaceFolders: [] });
    const dbLine = lines.find((line) => line.startsWith("engine.db:"));
    expect(dbLine).toBeDefined();
    expect(dbLine).toContain("mode=");
    expect(dbLine).toContain("host=");
    expect(dbLine).toContain("port=");
    expect(dbLine).toContain("graph=cpg");
  });
});

describe("SHOW_LOG_COMMAND", () => {
  test("command id matches the one contributed in package.json", () => {
    expect(SHOW_LOG_COMMAND).toBe("cpg.showLog");
  });
});

describe("LOG_CHANNEL_NAME", () => {
  test("is the channel name activation logs to", () => {
    expect(LOG_CHANNEL_NAME).toBe("CPG");
  });
});
