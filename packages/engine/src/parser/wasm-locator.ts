/**
 * Where the grammar `.wasm` files live.
 *
 * Resolution order, most specific first:
 *   1. an explicit directory passed by the caller;
 *   2. `CPG_GRAMMAR_DIR`;
 *   3. the `wasm/` directory of the installed `@vscode/tree-sitter-wasm`.
 *
 * Why (3) is written as `require.resolve("@vscode/tree-sitter-wasm/package.json")`
 * and then `../wasm`, rather than anything relative to this file: this module
 * sits at `src/parser/` under `bun test` (the package's "bun" export condition
 * points at source) and at `dist/parser/` after `tsc --build`. A `__dirname`
 * walk would need a different number of `..` in each, and would break again the
 * first time the output layout changes. Package resolution is identical in
 * both, and in a consumer's `node_modules` too. `package.json` is the anchor
 * because the package declares no `exports` field — every subpath is reachable
 * — and because Node's resolver will not hand back a `.wasm` path for us.
 *
 * Why (1) and (2) exist at all: a bundler rewrites `require.resolve`, so the
 * VSIX build (M3, "wasm via file loader") copies the four `.wasm` next to the
 * bundle and points the backend at that folder instead. The seam is here so
 * that is a one-line change at construction, not a patch to this file.
 */
import { dirname, join } from "node:path";

/** Environment variable that overrides grammar `.wasm` discovery. */
export const GRAMMAR_DIR_ENV = "CPG_GRAMMAR_DIR";

const GRAMMAR_PACKAGE = "@vscode/tree-sitter-wasm";

/** Absolute path of the directory holding the grammar `.wasm` files. */
export function resolveGrammarDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }

  const fromEnv = process.env[GRAMMAR_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }

  let packageJson: string;
  try {
    packageJson = require.resolve(`${GRAMMAR_PACKAGE}/package.json`);
  } catch (cause) {
    throw new Error(
      `Cannot locate the '${GRAMMAR_PACKAGE}' package that ships the grammar .wasm files. ` +
        `Install it, or set ${GRAMMAR_DIR_ENV} to a directory containing them.`,
      { cause },
    );
  }
  return join(dirname(packageJson), "wasm");
}
