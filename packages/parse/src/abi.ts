// REAL: AbiNotReadyError. SEAT: createAbiGate, checkGrammarAbi (U6a.1-close implements them).
// The grammar ABI gate (C-PARSE I13), ported from 27361a3:packages/engine/src/parser/abi.ts.
//
// THE TRAP: in web-tree-sitter 0.27, LANGUAGE_VERSION and MIN_COMPATIBLE_VERSION are module-level
// `export let` bindings that stay `undefined` until `Parser.init()` resolves. Read them a line too
// early and `abi < undefined || abi > undefined` is false: the gate passes every grammar while
// checking nothing (DEFECT-ABI-VACUOUS). So the range is read only through a gate that opens when
// init resolves, and a range that is not two integers is an error, never a skipped check.

/** Reading the ABI range before init resolved: a caller bug (I13), one of C-PARSE's two throws. */
export class AbiNotReadyError extends Error {
  constructor() {
    super('the grammar ABI range was read before Parser.init() resolved');
    this.name = 'AbiNotReadyError';
  }
}

/** Inclusive range of grammar ABI versions the runtime accepts. */
export interface AbiRange {
  /** `MIN_COMPATIBLE_VERSION`. */
  readonly minCompatible: number;
  /** `LANGUAGE_VERSION`. */
  readonly languageVersion: number;
}

/**
 * The parser runtime behind a seam (controller decision 99): web-tree-sitter in production
 * (service.ts), a stand-in in tests, so a failed init and an unreadable or narrow range are
 * reachable.
 */
export interface ParserRuntime {
  init(): Promise<void>;
  /** The live bindings. In web-tree-sitter they are `undefined` until init() resolves. */
  abiBindings(): {
    readonly minCompatible: number | undefined;
    readonly languageVersion: number | undefined;
  };
}

export type AbiRangeOutcome =
  | { readonly ok: true; readonly range: AbiRange }
  | { readonly ok: false; readonly message: string };

export interface AbiGate {
  /**
   * Runs `runtime.init()`. The gate opens when it resolves and stays open; a rejection leaves it
   * shut and propagates.
   */
  init(): Promise<void>;
  /**
   * Reads the bindings at call time (they are live). Throws AbiNotReadyError while the gate is
   * shut (I13). Two positive integers with minCompatible <= languageVersion are the range;
   * anything else is `ok: false` (abi-unreadable).
   */
  range(): AbiRangeOutcome;
}

export function createAbiGate(_runtime: ParserRuntime): AbiGate {
  throw new Error('SEAT: createAbiGate (C-PARSE I13) lands in U6a.1-close');
}

/**
 * Why a grammar's ABI is outside the range (inclusive at both ends), or undefined when it is
 * inside. A version that is not a positive integer is outside. The reason says "too old" or
 * "too new" and names the range as `<min>..<max>`.
 */
export function checkGrammarAbi(_abiVersion: number, _range: AbiRange): string | undefined {
  throw new Error('SEAT: checkGrammarAbi (C-PARSE I13) lands in U6a.1-close');
}
