import { describe, expect, test } from "bun:test";

import { EXTENSION_VERSION, SHOW_VERSION_COMMAND, versionMessage } from "../../src/index.ts";

describe("versionMessage", () => {
  test("names the extension and the engine it is linked against", () => {
    const message = versionMessage();
    expect(message).toContain(`@cpg/vscode@${EXTENSION_VERSION}`);
    expect(message).toContain("@cpg/engine@");
  });

  test("command id matches the one contributed in package.json", () => {
    expect(SHOW_VERSION_COMMAND).toBe("cpg.showVersion");
  });
});
