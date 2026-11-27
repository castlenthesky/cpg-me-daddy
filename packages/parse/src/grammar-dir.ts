// SEAT: resolveGrammarDir (U6a.1-close implements it).
// The grammar-dir locator (C-PARSE I10, I11), ported from
// 27361a3:packages/engine/src/parser/wasm-locator.ts.
//
// Why the package anchor is `<dir of the package's package.json>/wasm` and not a path from this
// file: this module sits at `src/` under vitest and at `dist/` after `tsc -b`, and in a consumer's
// node_modules too. Package resolution is the same in all of them; a `__dirname` walk is not.
// Why the overrides exist: a bundler rewrites `require.resolve`, so a VSIX copies the `.wasm` next
// to its bundle and names that folder explicitly (C-PARSE Q1).
import type { GrammarDirResolver } from './contract';

/**
 * explicit > `env.CPG_GRAMMAR_DIR` > package anchor, named in `via` (I11). Pure: it reads only the
 * request, never `process.env`, `__dirname`, the repo root or the cwd (I10).
 *
 * - An empty explicit or env value is unset and falls through to the next rule.
 * - A relative value is refused (`ok: false`, via that rule), never resolved against the cwd and
 *   never passed over for the next rule. So is a relative path from `resolvePackageJson`.
 * - `resolvePackageJson(packageName)` is called only when both overrides are unset. Its throw
 *   becomes `ok: false` via `package-anchor`, with a message naming the package and
 *   CPG_GRAMMAR_DIR. The resolver itself never throws.
 */
export const resolveGrammarDir: GrammarDirResolver = () => {
  throw new Error('SEAT: resolveGrammarDir (C-PARSE I10, I11) lands in U6a.1-close');
};
