// The walker's glob dialect, ported from 27361a3:packages/engine/src/workspace/glob.ts. A small,
// hand-compiled subset, so an excluded directory is pruned BEFORE the walker descends into it.
//
//   **          zero or more path segments
//   *           any run of characters within one segment (never crosses `/`)
//   ?           exactly one character within one segment
//   leading /   anchors to the workspace root; otherwise the pattern matches at any depth
//   trailing /  directory-only
// No braces, extglobs or `!` negation.

interface CompiledPattern {
  readonly regex: RegExp;
  readonly dirOnly: boolean;
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

function escapeLiteral(char: string): string {
  return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
}

/** Translates one already-anchored pattern body into a regex source string. */
function translate(body: string): string {
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body.charAt(i);
    if (c === '*') {
      if (body[i + 1] === '*') {
        const next = body[i + 2];
        if (next === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (next === undefined) {
          out += '.*';
          i += 2;
          continue;
        }
        // `**` not followed by `/` or end-of-pattern is outside the documented
        // subset; degrade to a single-segment wildcard rather than throw.
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeLiteral(c);
    i += 1;
  }
  return out;
}

function compileOne(raw: string): CompiledPattern {
  let body = raw;
  const anchored = body.startsWith('/');
  if (anchored) {
    body = body.slice(1);
  }
  const dirOnly = body.endsWith('/');
  if (dirOnly) {
    body = body.slice(0, -1);
  }
  if (!anchored) {
    body = body.length === 0 ? '**' : `**/${body}`;
  }
  return { regex: new RegExp(`^${translate(body)}$`), dirOnly };
}

/** Matches a workspace-relative POSIX path against a compiled pattern set. */
export interface PathMatcher {
  /** For a directory, both `path` and `path/` are tried, so `x/**` prunes `x` itself. */
  test(path: string, isDirectory: boolean): boolean;
}

/** Compiles `patterns` once. */
export function compileMatcher(patterns: readonly string[]): PathMatcher {
  // REAL
  const compiled = patterns.map(compileOne);
  return {
    test(path: string, isDirectory: boolean): boolean {
      for (const pattern of compiled) {
        if (pattern.dirOnly && !isDirectory) {
          continue;
        }
        if (pattern.regex.test(path)) {
          return true;
        }
        if (isDirectory && pattern.regex.test(`${path}/`)) {
          return true;
        }
      }
      return false;
    },
  };
}
