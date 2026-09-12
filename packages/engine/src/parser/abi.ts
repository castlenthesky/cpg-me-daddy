/**
 * Grammar ABI compatibility gate (F4 / spike SP1).
 *
 * A tree-sitter grammar `.wasm` encodes an ABI version. The `web-tree-sitter`
 * runtime accepts an inclusive range of them, `[MIN_COMPATIBLE_VERSION,
 * LANGUAGE_VERSION]`. Loading a grammar outside that range does not fail
 * cleanly — it fails as an empty `Error` node at the root, or worse, as a tree
 * that is subtly wrong. SP1 exists to turn that into a loud, named failure at
 * load time.
 *
 * Everything here is pure and synchronous on purpose: the four grammars we
 * actually ship are all in range, so the failure path can only be exercised by
 * calling these functions directly with out-of-range numbers. A gate nobody has
 * watched fail is not a gate (GR1), so this is the seam the tests drive.
 */

/** Inclusive range of grammar ABI versions the parser runtime accepts. */
export interface AbiRange {
  /** Oldest grammar ABI the runtime can load. `MIN_COMPATIBLE_VERSION`. */
  readonly minCompatible: number;
  /** Newest grammar ABI the runtime can load. `LANGUAGE_VERSION`. */
  readonly languageVersion: number;
}

/** Thrown when a grammar's ABI cannot be established or is out of range. */
export class AbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbiError";
  }
}

/** ABI versions are small positive integers. Anything else is a bug, not a version. */
function isAbiVersion(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Validate the runtime's supported ABI range, or throw.
 *
 * THE TRAP THIS EXISTS FOR: in web-tree-sitter 0.27 `LANGUAGE_VERSION` and
 * `MIN_COMPATIBLE_VERSION` are module-level `export let` bindings — NOT statics
 * on `Language` — and they are `undefined` until `await Parser.init()` has
 * resolved. Read them a line too early and every downstream comparison is
 * `abi < undefined`, which is `false`, which silently passes. The check would
 * look green while checking nothing. So an unreadable range is itself a loud
 * error here, never a skipped check.
 */
export function requireAbiRange(
  minCompatible: number | undefined,
  languageVersion: number | undefined,
): AbiRange {
  if (!isAbiVersion(minCompatible) || !isAbiVersion(languageVersion)) {
    throw new AbiError(
      "Grammar ABI range is unreadable " +
        `(MIN_COMPATIBLE_VERSION=${String(minCompatible)}, ` +
        `LANGUAGE_VERSION=${String(languageVersion)}). ` +
        "In web-tree-sitter these are module-level `export let` bindings that stay `undefined` " +
        "until `await Parser.init()` resolves — read them only after init. " +
        "Refusing to load a grammar against an unknown ABI range, because the comparison would " +
        "pass vacuously.",
    );
  }
  if (minCompatible > languageVersion) {
    throw new AbiError(
      `Grammar ABI range is inverted (MIN_COMPATIBLE_VERSION=${minCompatible} > ` +
        `LANGUAGE_VERSION=${languageVersion}). The parser runtime reported a range it cannot ` +
        "satisfy; this is a web-tree-sitter build problem, not a grammar problem.",
    );
  }
  return { minCompatible, languageVersion };
}

/**
 * Assert one loaded grammar's ABI is within the runtime's supported range.
 *
 * @param grammar   Grammar id, so the error names the culprit.
 * @param abiVersion `Language.abiVersion` of the loaded grammar. (`Language.version`
 *                   does not exist in 0.27; it reads back `undefined`.)
 * @param minCompatible `MIN_COMPATIBLE_VERSION`, read after `Parser.init()`.
 * @param languageVersion `LANGUAGE_VERSION`, read after `Parser.init()`.
 * @throws AbiError naming the grammar, its ABI and the supported range.
 */
export function assertAbiCompatible(
  grammar: string,
  abiVersion: number | undefined,
  minCompatible: number | undefined,
  languageVersion: number | undefined,
): AbiRange {
  const range = requireAbiRange(minCompatible, languageVersion);

  if (!isAbiVersion(abiVersion)) {
    throw new AbiError(
      `Grammar '${grammar}' reported no usable ABI version (got ${String(abiVersion)}). ` +
        "Expected `Language.abiVersion` to be a positive integer — a grammar that cannot state " +
        `its ABI cannot be trusted against the supported range ` +
        `[${range.minCompatible}, ${range.languageVersion}].`,
    );
  }

  if (abiVersion < range.minCompatible || abiVersion > range.languageVersion) {
    const direction = abiVersion < range.minCompatible ? "too old" : "too new";
    const fix =
      abiVersion < range.minCompatible
        ? "Regenerate the grammar with a newer tree-sitter-cli"
        : "Upgrade web-tree-sitter, or regenerate the grammar with an older tree-sitter-cli";
    throw new AbiError(
      `Grammar '${grammar}' has ABI version ${abiVersion}, which is ${direction} for this ` +
        `web-tree-sitter runtime (supported range [${range.minCompatible}, ` +
        `${range.languageVersion}]). ${fix}. Refusing to parse with it: an ABI mismatch does ` +
        "not fail cleanly, it yields silently wrong trees.",
    );
  }

  return range;
}
