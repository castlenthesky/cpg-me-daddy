import { describe, expect, test } from "bun:test";
/**
 * M0.2's gate, literally: "walking test/fixtures/ yields an exactly-asserted
 * file list; node_modules / .venv / __pycache__ proven excluded." The legacy
 * root `test/fixtures/code_examples/python/` is the one place in this repo
 * with real, checked-in `__pycache__/*.pyc` files (a precedent for reading
 * root `test/fixtures/` from an engine test already exists in
 * `test/unit/golden/hello-world.cpg.test.ts`). `node_modules`/`.venv` are not
 * checked in anywhere — `.gitignore` would refuse them — so those two are
 * covered instead by the runtime-built trees in `walker.test.ts`.
 */
import { join } from "node:path";

import { walkWorkspace } from "../../../src/workspace/walker.ts";

const FIXTURE_ROOT = join(__dirname, "../../../../../test/fixtures/code_examples/python");

describe("walkWorkspace against the checked-in python fixture", () => {
  test("yields exactly the 10 .py source files, excluding README.md and __pycache__/*.pyc", async () => {
    const { files, stats } = await walkWorkspace({ root: FIXTURE_ROOT });

    expect(files.map((f) => f.path).toSorted()).toEqual(
      [
        "hello_world.py",
        "src/__init__.py",
        "src/api/__init__.py",
        "src/api/routes.py",
        "src/database/__init__.py",
        "src/database/db.py",
        "src/main.py",
        "src/services/__init__.py",
        "src/services/greeting.py",
        "src/services/item_service.py",
      ].toSorted(),
    );
    expect(files.every((f) => f.language === "python")).toBe(true);
    // README.md: no grammar. The three __pycache__/*.pyc files: pruned by
    // directory exclusion before their extension is ever inspected.
    expect(stats.filesUnsupported).toBe(1);
  });
});
