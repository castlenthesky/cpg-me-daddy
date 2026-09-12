import { describe, expect, test } from "bun:test";

import { CLI_VERSION, versionBanner } from "../../src/index.ts";

describe("versionBanner", () => {
  test("names both the cli and the engine it is linked against", () => {
    const banner = versionBanner();
    expect(banner).toContain(`@cpg/cli@${CLI_VERSION}`);
    expect(banner).toContain("@cpg/engine@");
  });
});
