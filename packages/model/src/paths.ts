/**
 * The graph's path forms (DQ-02, lesson L-10).
 *
 * `WorkspacePath` is the ONLY path form the graph stores: workspace-relative,
 * POSIX `/`, no leading `./`, no `.`/`..`/empty segments, and `'.'` for the
 * workspace root itself. `AbsolutePath` is a native-separator disk path and
 * lives only in the FilesystemProbe and SourceOpener adapters.
 *
 * Both are branded so a plain `string` cannot be passed where either is
 * expected, and neither is assignable to the other. The brand is type-only
 * (`declare const`), so `import type` is enough and nothing is emitted.
 *
 * No imports, and in particular no `node:path`: this module also loads in the
 * webview/browser. The calling side passes its native separator instead.
 */

declare const pathBrand: unique symbol;

/** Workspace-relative, POSIX `/`, no leading `./`, no `.`/`..`/empty segments; `'.'` is the root itself. */
export type WorkspacePath = string & { readonly [pathBrand]: 'workspace' };

/** A native-separator absolute path. Lives only in FilesystemProbe and SourceOpener adapters (DQ-02). */
export type AbsolutePath = string & { readonly [pathBrand]: 'absolute' };

/** The native separator of the side calling. The adapter passes `node:path`'s `sep` (or '/' for vscode URIs). */
export type PathSeparator = '/' | '\\';

/**
 * The workspace root (`'.'`, the archive walker's DIRECTORY convention). REAL: pure type plumbing.
 * The one sanctioned literal cast; paths.test.ts asserts isWorkspacePath(WORKSPACE_ROOT).
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one sanctioned brand cast, checked in paths.test.ts.
export const WORKSPACE_ROOT = '.' as WorkspacePath;

/**
 * True iff `value` is a well-formed WorkspacePath. This is the SINGLE definition of well-formed:
 * toWorkspacePath checks its own result against it before returning, and toAbsolutePath checks its input.
 * Well-formed means `'.'`, or one or more `/`-separated segments, none empty, `.` or `..`, no leading `/`,
 * no trailing `/`, no U+0000. Every other character is allowed, including `\` and `:` (both are legal
 * POSIX filename characters, so `C:x` and `a\b.ts` are valid). A boundary that must reject a
 * drive-letter-looking input (zod on argv/config) checks that itself.
 */
export function isWorkspacePath(value: string): value is WorkspacePath {
  // REAL
  if (value === '.') return true;
  if (value.length === 0 || value.includes('\u0000')) return false;
  return value.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const UNC_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

function isSep(ch: string | undefined, sep: PathSeparator): boolean {
  return sep === '/' ? ch === '/' : ch === '/' || ch === '\\';
}

/** Drops all trailing separators (so the bare roots `/` and `C:\` become '' and `C:`). */
function stripTrailing(value: string, sep: PathSeparator): string {
  let end = value.length;
  while (end > 0 && isSep(value[end - 1], sep)) end -= 1;
  return value.slice(0, end);
}

/** Validates that `root` is absolute for `sep`; returns it with trailing separators stripped. */
function checkRoot(root: string, sep: PathSeparator): string {
  const absolute =
    sep === '/' ? root.startsWith('/') : DRIVE_ROOT.test(root) || UNC_ROOT.test(root);
  if (!absolute) throw new Error(`root is not absolute: "${root}"`);
  return stripTrailing(root, sep);
}

/**
 * The ONE conversion from a disk path into the graph's path form (L-10: startsWith + slice, never replace).
 *
 * Absolute roots: in '/' mode, a root starting with `/`. In '\\' mode, `X:\` or `X:/` (X a letter) or a
 * UNC root `\\host\share` (either separator); a root-relative `\ws` or `/ws`, a bare `X:`, or a relative
 * root throws `root is not absolute`.
 * Separators: in '\\' mode both `\` and `/` count (Windows accepts both); in '/' mode only `/` does, and
 * `\` and `:` are ordinary filename characters (so `/ws/C:x` gives `C:x`, a valid WorkspacePath).
 * Trailing separators on either argument are ignored. No other normalization.
 *
 * Throws Error whose message starts with, checked in this order:
 * `root is not absolute`; `path contains NUL` for U+0000; `path escapes root` when `absolute` is not
 * `root` or under it at a segment boundary, or has a `..` segment; `path is not normalized` for an empty
 * or `.` segment. The result is checked with isWorkspacePath before it is returned (P-1).
 *
 * C-WATCH INV-4's `toRelativePosix` is this function under its spec name; there is no second copy.
 */
export function toWorkspacePath(
  root: string,
  absolute: string,
  sep: PathSeparator = '/',
): WorkspacePath {
  // REAL
  const base = checkRoot(root, sep);
  if (absolute.includes('\u0000')) throw new Error('path contains NUL');
  const abs = stripTrailing(absolute, sep);
  const escapes = (): Error => new Error(`path escapes root: "${absolute}" is not under "${root}"`);
  if (absolute.length === 0 || !abs.startsWith(base)) throw escapes();
  const rest = abs.slice(base.length);
  if (rest.length === 0) return WORKSPACE_ROOT;
  if (!isSep(rest[0], sep)) throw escapes();
  const segments = rest.slice(1).split(sep === '/' ? '/' : /[\\/]/);
  if (segments.includes('..')) throw escapes();
  if (segments.some((seg) => seg === '' || seg === '.')) {
    throw new Error(`path is not normalized: "${absolute}"`);
  }
  const result = segments.join('/');
  if (!isWorkspacePath(result)) throw new Error(`path is not normalized: "${absolute}"`);
  return result;
}

/**
 * The inverse, for FilesystemProbe and SourceOpener implementations ONLY (check-deps will verify the import
 * sites in a later unit). root (trailing separators stripped) + sep + path with `/` turned into `sep`;
 * `'.'` returns root itself. Absolute roots are as for toWorkspacePath.
 * Throws `root is not absolute`; or `not a workspace path` when `path` fails isWorkspacePath (a forged
 * cast), or when in '\\' mode `path` contains `\` (such a file cannot exist on Windows, and the round
 * trip would turn it into `/`). So P-2's round trip holds for every path this function accepts.
 */
export function toAbsolutePath(
  root: string,
  path: WorkspacePath,
  sep: PathSeparator = '/',
): AbsolutePath {
  // REAL
  const base = checkRoot(root, sep);
  if (!isWorkspacePath(path) || (sep === '\\' && path.includes('\\'))) {
    throw new Error(`not a workspace path: "${path}"`);
  }
  // The brand is applied here, the one place a disk path is minted.
  if (path === '.') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minting an AbsolutePath.
    return (base === '' || /^[A-Za-z]:$/.test(base) ? base + sep : base) as AbsolutePath;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minting an AbsolutePath.
  return (base + sep + (sep === '/' ? path : path.split('/').join(sep))) as AbsolutePath;
}
