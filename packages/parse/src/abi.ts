// REAL: the ABI gate (AbiNotReadyError, createAbiGate, checkGrammarAbi; C-PARSE I13), ported from
// 27361a3:packages/engine/src/parser/abi.ts.
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

type AbiRangeOutcome =
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

function isAbiVersion(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function createAbiGate(runtime: ParserRuntime): AbiGate {
  let open = false;
  return {
    async init() {
      await runtime.init();
      open = true;
    },
    range() {
      if (!open) throw new AbiNotReadyError();
      const { minCompatible, languageVersion } = runtime.abiBindings();
      if (!isAbiVersion(minCompatible) || !isAbiVersion(languageVersion)) {
        return {
          ok: false,
          message:
            'Grammar ABI range is unreadable ' +
            `(MIN_COMPATIBLE_VERSION=${String(minCompatible)}, ` +
            `LANGUAGE_VERSION=${String(languageVersion)}). ` +
            'In web-tree-sitter these bindings stay undefined until Parser.init() resolves; ' +
            'refusing to load a grammar against an unknown ABI range.',
        };
      }
      if (minCompatible > languageVersion) {
        return {
          ok: false,
          message:
            `Grammar ABI range is inverted (MIN_COMPATIBLE_VERSION=${String(minCompatible)} > ` +
            `LANGUAGE_VERSION=${String(languageVersion)}). ` +
            'The parser runtime reported a range it cannot satisfy.',
        };
      }
      return { ok: true, range: { minCompatible, languageVersion } };
    },
  };
}

/**
 * Why a grammar's ABI is outside the range (inclusive at both ends), or undefined when it is
 * inside. A version that is not a positive integer is outside. The reason says "too old" or
 * "too new" and names the range as `<min>..<max>`.
 *
 * Loading a grammar outside the runtime's supported ABI range does not fail cleanly — it fails as
 * an empty `ERROR` node at the root, or worse, as a tree that is subtly wrong. Checking at load
 * time turns an ABI mismatch into a loud, named failure instead of silently wrong trees.
 */
export function checkGrammarAbi(abiVersion: number, range: AbiRange): string | undefined {
  const span = `${String(range.minCompatible)}..${String(range.languageVersion)}`;
  if (!isAbiVersion(abiVersion)) {
    return `has no usable ABI version (got ${String(abiVersion)}; runtime accepts ${span})`;
  }
  if (abiVersion < range.minCompatible) {
    return (
      `has ABI ${String(abiVersion)}, which is too old for this runtime (accepts ${span}); ` +
      'regenerate the grammar with a newer tree-sitter-cli'
    );
  }
  if (abiVersion > range.languageVersion) {
    return (
      `has ABI ${String(abiVersion)}, which is too new for this runtime (accepts ${span}); ` +
      'upgrade web-tree-sitter, or regenerate the grammar with an older tree-sitter-cli'
    );
  }
  return undefined;
}
