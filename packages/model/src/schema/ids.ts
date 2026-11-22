/**
 * Node ids: the single implementation of `ID_RULE` (04-schema.yaml -> id_rule, U1.1.3).
 *
 * No producer concatenates an id by hand: mint with `makeNodeId`, read back with `parseNodeId`.
 *
 *   file      := "file:" esc_path(path)
 *   directory := "dir:"  esc_path(path)
 *   scoped    := "file:" esc_path(path) ":" kind ":" esc_seg(s0) ("." esc_seg(si))* [ ":" ordinal | ":#" bodyHash ]
 *
 * - Every rule-addressed :CPG id starts with its FILE's id (`file:<path>`), so file ownership is a prefix test (I-15).
 * - Scope segments are lexical names joined with `.`; MODULE's scope is `[MODULE_SCOPE]` (`$root`).
 * - `kind` is any `/^[A-Z][A-Z0-9_]*$/` token other than `FILE`/`DIRECTORY`; it is NOT checked against
 *   NODE_LABELS, so future tiers (ND-10's `STMT`) mint additively.
 * - An ordinal is canonical decimal (parent-scope-relative, the caller counts); a bodyHash is `#` + lowercase hex
 *   (1..64 chars), the marker keeps an all-digit hash from parsing back as an ordinal. The two are exclusive.
 * - Escaping: in the path `%` -> `%25`, `:` -> `%3A`; in a scope segment additionally `.` -> `%2E`. Nothing else.
 * - DIRECTORY ids are `dir:<path>` (root `dir:.`), a form 04-schema's examples do not list (flagged for sign-off).
 * - SYMBOL, TAG, META_DATA and COMMUNITY are not addressed by the rule; there is no arm for them.
 * - `makeNodeId` throws on invalid parts (a producer bug, L-08); `parseNodeId` never throws (ids arrive from outside).
 *
 * Do not parse an id to decide a node's kind: dispatch reads `node.type` (C-MODEL may_not, L-48). parseNodeId's
 * uses are round-trip proof, file-ownership checks and error localisation. Location comes from `data.location`.
 *
 * KNOWN LIMITATION: scope frames are names only, so `TYPE_DECL A > METHOD b` and `METHOD A > METHOD b` both give
 * `A.b`. U6a must not descend into nested named declarations, or raise a schema-version change.
 */
import { isWorkspacePath, type WorkspacePath } from '../paths';

/** MODULE's qualifiedScopePath (04-schema id_rule example `file:src/users.ts:MODULE:$root`). */
export const MODULE_SCOPE = '$root';

/** A node id that names something inside a file: `file:<path>:<kind>:<scope>[:ordinal|:#bodyHash]`. */
export type ScopedNodeIdParts = {
  readonly form: 'scoped';
  /** The owning file; never `'.'`. */
  readonly path: WorkspacePath;
  /** `/^[A-Z][A-Z0-9_]*$/`, not `'FILE'` or `'DIRECTORY'`; need not be a schema label (ND-10). */
  readonly kind: string;
  /** Lexical names, outermost first; each non-empty, no U+0000. */
  readonly scope: readonly [string, ...string[]];
} & (
  | { readonly ordinal?: never; readonly bodyHash?: never }
  /** Non-negative safe integer, parent-scope-relative. */
  | { readonly ordinal: number; readonly bodyHash?: never }
  /** `/^[0-9a-f]{1,64}$/`. */
  | { readonly bodyHash: string; readonly ordinal?: never }
);

/** The parsed form of a node id. `form` is the discriminant; `kind` is the id's label token, never a dispatch key (L-48). */
export type NodeIdParts =
  | { readonly form: 'file'; readonly path: WorkspacePath }
  | { readonly form: 'directory'; readonly path: WorkspacePath }
  | ScopedNodeIdParts;

const KIND = /^[A-Z][A-Z0-9_]*$/;
const ORDINAL = /^(?:0|[1-9][0-9]*)$/;
const BODY_HASH = /^[0-9a-f]{1,64}$/;
const NUL = '\u0000';

function escPath(path: string): string {
  return path.replaceAll('%', '%25').replaceAll(':', '%3A');
}

function escSeg(seg: string): string {
  return escPath(seg).replaceAll('.', '%2E');
}

/** Decodes only the escapes the encoder emits; undefined on any other `%`. */
function unesc(text: string): string | undefined {
  if (/%(?!25|3A|2E)/.test(text)) return undefined;
  return text.replaceAll('%2E', '.').replaceAll('%3A', ':').replaceAll('%25', '%');
}

function fail(reason: string): never {
  throw new Error(`invalid node id parts: ${reason}`);
}

function checkPath(path: string, allowRoot: boolean): void {
  if (typeof path !== 'string' || !isWorkspacePath(path))
    fail(`path is not a WorkspacePath: ${JSON.stringify(path)}`);
  if (!allowRoot && path === '.') fail("path must not be '.' for this form");
}

/** Renders `parts` per ID_RULE. Throws `Error('invalid node id parts: <reason>')` on invalid parts. */
export function makeNodeId(parts: NodeIdParts): string {
  // REAL
  if (parts.form !== 'file' && parts.form !== 'directory' && parts.form !== 'scoped') {
    fail('unknown form');
  }
  if (parts.form === 'directory') {
    checkPath(parts.path, true);
    return `dir:${escPath(parts.path)}`;
  }
  checkPath(parts.path, false);
  const fileId = `file:${escPath(parts.path)}`;
  if (parts.form === 'file') return fileId;
  const { kind, scope } = parts;
  if (!KIND.test(kind) || kind === 'FILE' || kind === 'DIRECTORY')
    fail(`bad kind ${JSON.stringify(kind)}`);
  if (scope.length === 0) fail('empty scope');
  for (const seg of scope) {
    if (typeof seg !== 'string' || seg.length === 0) fail('empty or non-string scope segment');
    if (seg.includes(NUL)) fail('scope segment contains U+0000');
  }
  const { ordinal, bodyHash } = parts;
  if (ordinal !== undefined && bodyHash !== undefined) fail('ordinal and bodyHash are exclusive');
  let suffix = '';
  if (ordinal !== undefined) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail(`bad ordinal ${String(ordinal)}`);
    suffix = `:${String(ordinal)}`;
  } else if (bodyHash !== undefined) {
    if (!BODY_HASH.test(bodyHash)) fail(`bad bodyHash ${JSON.stringify(bodyHash)}`);
    suffix = `:#${bodyHash}`;
  }
  return `${fileId}:${kind}:${scope.map(escSeg).join('.')}${suffix}`;
}

function parseUnchecked(id: string): NodeIdParts | undefined {
  if (id.includes(NUL)) return undefined;
  if (id.startsWith('dir:')) {
    const raw = id.slice(4);
    if (raw.includes(':')) return undefined;
    const path = unesc(raw);
    return path !== undefined && isWorkspacePath(path) ? { form: 'directory', path } : undefined;
  }
  if (!id.startsWith('file:')) return undefined;
  const fields = id.slice(5).split(':');
  const path = unesc(fields[0] ?? '');
  if (path === undefined || path === '.' || !isWorkspacePath(path)) return undefined;
  if (fields.length === 1) return { form: 'file', path };
  if (fields.length !== 3 && fields.length !== 4) return undefined;
  const kind = fields[1] ?? '';
  if (!KIND.test(kind) || kind === 'FILE' || kind === 'DIRECTORY') return undefined;
  const segs: string[] = [];
  for (const raw of (fields[2] ?? '').split('.')) {
    const seg = unesc(raw);
    if (seg === undefined || seg.length === 0) return undefined;
    segs.push(seg);
  }
  const [first, ...rest] = segs;
  if (first === undefined) return undefined;
  const scope: readonly [string, ...string[]] = [first, ...rest];
  const suffix = fields[3];
  if (suffix === undefined) return { form: 'scoped', path, kind, scope };
  if (suffix.startsWith('#')) {
    const bodyHash = suffix.slice(1);
    return BODY_HASH.test(bodyHash) ? { form: 'scoped', path, kind, scope, bodyHash } : undefined;
  }
  if (!ORDINAL.test(suffix)) return undefined;
  const ordinal = Number(suffix);
  return Number.isSafeInteger(ordinal) ? { form: 'scoped', path, kind, scope, ordinal } : undefined;
}

/** Inverse of makeNodeId. Returns undefined for any string makeNodeId cannot produce; never throws. */
export function parseNodeId(id: string): NodeIdParts | undefined {
  // REAL
  try {
    const parts = parseUnchecked(id);
    // Canonicality (ID-2): reject any spelling makeNodeId would not produce.
    return parts !== undefined && makeNodeId(parts) === id ? parts : undefined;
  } catch {
    return undefined;
  }
}
