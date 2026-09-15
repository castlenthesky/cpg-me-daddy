/** `isExcludedPath` / `pairFileRenames` — the watcher's pure diffing logic, no I/O. */
import { describe, expect, test } from "bun:test";

import { isExcludedPath, pairFileRenames } from "../../../src/watch/normalize.ts";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES } from "../../../src/workspace/defaults.ts";
import { compileMatcher } from "../../../src/workspace/glob.ts";

const include = compileMatcher(DEFAULT_INCLUDES);
const exclude = compileMatcher(DEFAULT_EXCLUDES);

describe("isExcludedPath", () => {
  test("a node_modules path is excluded, as a directory or as a file inside it", () => {
    expect(isExcludedPath("node_modules", true, include, exclude)).toBe(true);
    expect(isExcludedPath("node_modules/pkg/index.ts", false, include, exclude)).toBe(true);
  });

  test("an ordinary source file is not excluded", () => {
    expect(isExcludedPath("src/a.ts", false, include, exclude)).toBe(false);
  });

  test("re-applies a project-supplied anchored exclude parcel's coarse ignore cannot express", () => {
    const projectExclude = compileMatcher([...DEFAULT_EXCLUDES, "/legacy/**"]);
    expect(isExcludedPath("legacy/old.ts", false, include, projectExclude)).toBe(true);
    expect(isExcludedPath("packages/legacy/old.ts", false, include, projectExclude)).toBe(false);
  });
});

describe("pairFileRenames", () => {
  test("pairs a delete and a same-hash create into a move", () => {
    const knownFiles = new Map([["src/old.ts", { contentHash: "h1" }]]);
    const hashedCreates = new Map([["src/new.ts", { contentHash: "h1", sizeBytes: 30 }]]);

    const { moves, removals, survivingCreates } = pairFileRenames(
      ["src/old.ts"],
      hashedCreates,
      knownFiles,
    );

    expect(moves).toEqual([{ fromPath: "src/old.ts", toPath: "src/new.ts", kind: "file" }]);
    expect(removals).toEqual([]);
    expect(survivingCreates.size).toBe(0);
  });

  test("a delete with no matching-hash create is a real removal", () => {
    const knownFiles = new Map([["src/old.ts", { contentHash: "h1" }]]);
    const { moves, removals } = pairFileRenames(["src/old.ts"], new Map(), knownFiles);

    expect(moves).toEqual([]);
    expect(removals).toEqual(["src/old.ts"]);
  });

  test("a create with no matching delete survives as a real create/change", () => {
    const hashedCreates = new Map([["src/new.ts", { contentHash: "h1", sizeBytes: 10 }]]);
    const { moves, survivingCreates } = pairFileRenames([], hashedCreates, new Map());

    expect(moves).toEqual([]);
    expect(survivingCreates.get("src/new.ts")).toEqual({ contentHash: "h1", sizeBytes: 10 });
  });

  test("a delete for an unknown path (no prior hash) is never paired", () => {
    const hashedCreates = new Map([["src/new.ts", { contentHash: "h1", sizeBytes: 10 }]]);
    const { moves, removals, survivingCreates } = pairFileRenames(
      ["src/unknown.ts"],
      hashedCreates,
      new Map(),
    );

    expect(moves).toEqual([]);
    expect(removals).toEqual(["src/unknown.ts"]);
    expect(survivingCreates.size).toBe(1);
  });
});
