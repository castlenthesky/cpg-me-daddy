/**
 * The workspace walker's glob dialect (M0.2).
 *
 * Deliberately a small, hand-compiled subset — no third-party glob library.
 * Two reasons: (1) pruning has to happen *before* descending into an excluded
 * directory, which a "filter a full listing" API (`fs.glob`, most npm glob
 * packages) cannot express — it would enumerate ast-demo's 278 MB `.venv`
 * before rejecting it; (2) `fs.glob` is Node 22+ and `Bun.Glob` is Bun-only,
 * and this package must run unchanged inside the VS Code extension host.
 *
 * Supported forms, matched against a POSIX, workspace-relative path with no
 * leading slash:
 *
 *   `**`        zero or more path segments (may match nothing)
 *   `*`         any run of characters within one segment (never crosses `/`)
 *   `?`         exactly one character within one segment
 *   leading `/` anchors the pattern to the workspace root; otherwise the
 *               pattern matches at any depth, gitignore-style (as if `**`
 *               and a separator had been prepended)
 *   trailing `/` directory-only: the pattern is only tested against
 *               directories, never files
 *
 * No braces, no extglobs, no `!` negation. If M0.1-full's `.gitignore` merge
 * ever needs true gitignore semantics (negation, per-directory stacking),
 * that is the point to reach for the `ignore` package instead of growing
 * this file — not before.
 */

interface CompiledPattern {
  readonly regex: RegExp;
  readonly dirOnly: boolean;
}

/** Matches a workspace-relative path against a compiled set of patterns. */
export interface PathMatcher {
  /**
   * @param relPath POSIX, workspace-relative, no leading slash.
   * @param isDirectory Whether `relPath` names a directory. Directory-only
   *   patterns are skipped for files; both `relPath` and `relPath/` are tried
   *   for directories, so a directory pattern prunes the directory itself as
   *   well as everything a `/**` suffix would otherwise require separately.
   */
  test(relPath: string, isDirectory: boolean): boolean;
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

function escapeLiteral(char: string): string {
  return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
}

/** Translates one already-anchored pattern body into a regex source string. */
function translate(body: string): string {
  let out = "";
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === "*") {
      if (body[i + 1] === "*") {
        const next = body[i + 2];
        if (next === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        if (next === undefined) {
          out += ".*";
          i += 2;
          continue;
        }
        // "**" not followed by "/" or end-of-pattern is outside the
        // documented subset; degrade to a single-segment wildcard rather
        // than throw, so an odd pattern fails soft.
        out += "[^/]*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += escapeLiteral(c as string);
    i += 1;
  }
  return out;
}

function compileOne(raw: string): CompiledPattern {
  let body = raw;
  const anchored = body.startsWith("/");
  if (anchored) {
    body = body.slice(1);
  }
  const dirOnly = body.length > 0 && body.endsWith("/");
  if (dirOnly) {
    body = body.slice(0, -1);
  }
  if (!anchored) {
    body = body.length === 0 ? "**" : `**/${body}`;
  }
  const source = `^${translate(body)}$`;
  return { regex: new RegExp(source), dirOnly };
}

/** Compiles `patterns` once; the returned matcher is reused across every path tested. */
export function compileMatcher(patterns: readonly string[]): PathMatcher {
  const compiled = patterns.map(compileOne);
  return {
    test(relPath: string, isDirectory: boolean): boolean {
      for (const pattern of compiled) {
        if (pattern.dirOnly && !isDirectory) {
          continue;
        }
        if (pattern.regex.test(relPath)) {
          return true;
        }
        if (isDirectory && pattern.regex.test(`${relPath}/`)) {
          return true;
        }
      }
      return false;
    },
  };
}
