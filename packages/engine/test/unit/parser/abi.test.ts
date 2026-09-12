/**
 * The F4 ABI gate, driven at its failure modes.
 *
 * "The ABI assertion fails loudly on a deliberately mismatched grammar — test
 * that failure mode, don't assume it." All four grammars we ship are in range,
 * so the only honest way to exercise the failure path is to call the assertion
 * directly with numbers that are not. That is why it is a pure function.
 */
import { describe, expect, test } from "bun:test";

import { AbiError, assertAbiCompatible, requireAbiRange } from "../../../src/parser/abi.ts";

// The real values measured under web-tree-sitter 0.27.0.
const MIN = 13;
const MAX = 15;

describe("assertAbiCompatible", () => {
  test("accepts the ABIs the shipped grammars actually report", () => {
    // typescript/tsx report 14, javascript/python report 15.
    expect(assertAbiCompatible("typescript", 14, MIN, MAX)).toEqual({
      minCompatible: MIN,
      languageVersion: MAX,
    });
    expect(() => assertAbiCompatible("python", 15, MIN, MAX)).not.toThrow();
  });

  test("accepts both ends of the inclusive range", () => {
    expect(() => assertAbiCompatible("edge-min", MIN, MIN, MAX)).not.toThrow();
    expect(() => assertAbiCompatible("edge-max", MAX, MIN, MAX)).not.toThrow();
  });

  test("rejects a grammar whose ABI is too old, naming grammar, ABI and range", () => {
    let caught: unknown;
    try {
      assertAbiCompatible("fake-ancient", 12, MIN, MAX);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AbiError);
    const message = (caught as Error).message;
    expect(message).toContain("fake-ancient");
    expect(message).toContain("12");
    expect(message).toContain("[13, 15]");
    expect(message).toContain("too old");
    // Actionable, not just descriptive.
    expect(message).toContain("tree-sitter-cli");
  });

  test("rejects a grammar whose ABI is too new, naming grammar, ABI and range", () => {
    expect(() => assertAbiCompatible("fake-future", 99, MIN, MAX)).toThrow(AbiError);
    expect(() => assertAbiCompatible("fake-future", 99, MIN, MAX)).toThrow(
      /'fake-future' has ABI version 99.*too new.*\[13, 15\]/s,
    );
    expect(() => assertAbiCompatible("fake-future", 99, MIN, MAX)).toThrow(
      /Upgrade web-tree-sitter/,
    );
  });

  test("rejects a grammar that reports no ABI at all", () => {
    // `Language.version` does not exist in 0.27 — reading it gives undefined.
    // If a future refactor grabs the wrong property, this must be loud.
    expect(() => assertAbiCompatible("no-abi", undefined, MIN, MAX)).toThrow(AbiError);
    expect(() => assertAbiCompatible("no-abi", undefined, MIN, MAX)).toThrow(
      /'no-abi' reported no usable ABI version \(got undefined\)/,
    );
  });

  test("rejects a non-integer ABI", () => {
    expect(() => assertAbiCompatible("nan", Number.NaN, MIN, MAX)).toThrow(AbiError);
    expect(() => assertAbiCompatible("fractional", 14.5, MIN, MAX)).toThrow(AbiError);
    expect(() => assertAbiCompatible("zero", 0, MIN, MAX)).toThrow(AbiError);
  });
});

describe("requireAbiRange — the undefined-before-init trap", () => {
  test("throws when both constants are undefined, instead of skipping the check", () => {
    expect(() => requireAbiRange(undefined, undefined)).toThrow(AbiError);
    expect(() => requireAbiRange(undefined, undefined)).toThrow(/Parser\.init\(\)/);
  });

  test("throws when only one constant is undefined", () => {
    expect(() => requireAbiRange(MIN, undefined)).toThrow(AbiError);
    expect(() => requireAbiRange(undefined, MAX)).toThrow(AbiError);
  });

  test("assertAbiCompatible refuses to compare against an unknown range", () => {
    // THE BUG THIS GATE EXISTS FOR: `12 < undefined` is false and
    // `12 > undefined` is false, so a naive range check passes an ABI-12
    // grammar silently. Prove we throw instead.
    const unknownBound = undefined as unknown as number;
    const staleAbi = 12;
    expect(staleAbi < unknownBound).toBe(false);
    expect(staleAbi > unknownBound).toBe(false);
    expect(() => assertAbiCompatible("would-have-passed", 12, undefined, undefined)).toThrow(
      AbiError,
    );
  });

  test("throws on an inverted range", () => {
    expect(() => requireAbiRange(15, 13)).toThrow(AbiError);
    expect(() => requireAbiRange(15, 13)).toThrow(/inverted/);
  });
});
