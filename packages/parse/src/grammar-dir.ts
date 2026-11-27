// REAL: the grammar-dir locator (C-PARSE I10, I11), ported from
// 27361a3:packages/engine/src/parser/wasm-locator.ts.
//
// Why the package anchor is `<dir of the package's package.json>/wasm` and not a path from this
// file: this module sits at `src/` under vitest and at `dist/` after `tsc -b`, and in a consumer's
// node_modules too. Package resolution is the same in all of them; a `__dirname` walk is not.
// Why the overrides exist: a bundler rewrites `require.resolve`, so a VSIX copies the `.wasm` next
// to its bundle and names that folder explicitly (C-PARSE Q1).
import { dirname, isAbsolute, join } from 'node:path';
import type { GrammarDirOutcome, GrammarDirResolver, GrammarDirVia } from './contract';

function requireAbsolute(dir: string, via: GrammarDirVia): GrammarDirOutcome {
  if (!isAbsolute(dir)) {
    return {
      ok: false,
      via,
      message: `grammar directory from ${via} must be an absolute path, got '${dir}'`,
    };
  }
  return { ok: true, dir, via };
}

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
export const resolveGrammarDir: GrammarDirResolver = (request) => {
  if (request.explicit !== undefined && request.explicit !== '') {
    return requireAbsolute(request.explicit, 'explicit');
  }

  const fromEnv = request.env?.CPG_GRAMMAR_DIR;
  if (fromEnv !== undefined && fromEnv !== '') {
    return requireAbsolute(fromEnv, 'CPG_GRAMMAR_DIR');
  }

  let packageJson: string;
  try {
    packageJson = request.resolvePackageJson(request.packageName);
  } catch (cause) {
    return {
      ok: false,
      via: 'package-anchor',
      message:
        `Cannot locate the '${request.packageName}' package that ships the grammar .wasm files ` +
        `(${String(cause)}). Install it, or set CPG_GRAMMAR_DIR to a directory holding the ` +
        'grammar .wasm files.',
    };
  }

  return requireAbsolute(join(dirname(packageJson), 'wasm'), 'package-anchor');
};
