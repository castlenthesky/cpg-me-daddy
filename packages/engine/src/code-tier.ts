// The code tier of an index (U6a.3-2; controller decisions 96, 100, 101): the walker's bytes in, one
// ExtractedFile per adapter file out, through ONE ParseService per engine. The engine reads the
// bytes once (03-architecture §4: the walker's read is that read) and hands PARSE text, never a path
// (C-PARSE I19); the walker's revision_id travels through and nothing re-hashes (C-WATCH INV-26).
// attachSourceFile is ported from f18ee71:packages/engine/src/indexer/source-file.ts (C-EXTRACT Q8),
// and lineCountOf from f18ee71:packages/engine/src/indexer/index-workspace.ts:204.
//
// SEAT (U6a.3-2 RED): every export below throws until the implementation lands.

import type { ExtractedFile, Extractor } from '@cpg/extract';
import type {
  GrammarDirOutcome,
  GrammarSource,
  LanguageRegistry,
  ParseService,
  ParseServiceOptions,
} from '@cpg/parse';
import type { WriteOp } from '@cpg/store';
import type { WalkedFile } from './walker/walker';

/** The replace-file arm of WriteOp. */
export type ReplaceFileOp = Extract<WriteOp, { readonly kind: 'replace-file' }>;

/**
 * The text PARSE is handed: `new TextDecoder('utf-8')` over the raw bytes, so a UTF-8 BOM is
 * stripped (column 0 of line 1 is the first character after it) and an invalid sequence becomes
 * U+FFFD. Never throws.
 */
export function decodeSource(_bytes: Uint8Array): string {
  throw new Error('SEAT: decodeSource lands in U6a.3-2 (controller decision 100)');
}

/** The file's line count (ExtractRequest.lineCount, FILE.loc): 0 for empty text, else `text.split('\n').length`. */
export function lineCountOf(_text: string): number {
  throw new Error('SEAT: lineCountOf lands in U6a.3-2');
}

/**
 * The node:fs GrammarSource (C-PARSE: the ONLY byte channel into the parser; never throws).
 * `load(ref)` calls `locate(ref.packageName)` on every load (a failure is never memoised, I15):
 * - `ok: false` from the locator is `{ ok: false, message }` with the locator's message;
 * - else it reads `join(dir, ref.wasmFile)`: `{ ok: true, bytes, origin }` with `origin` that path,
 *   or `{ ok: false, message }` naming that path and the read error.
 * `describe()` is `node:fs grammar source`.
 */
export function createDiskGrammarSource(
  _locate: (packageName: string) => GrammarDirOutcome,
): GrammarSource {
  throw new Error('SEAT: createDiskGrammarSource lands in U6a.3-2 (controller decision 100)');
}

/**
 * Appends the one `SOURCE_FILE` edge row from the op's MODULE row to its FILE (C-EXTRACT Q8):
 * `{ type: 'SOURCE_FILE', fromLabel: 'MODULE', fromKey: <the first MODULE row's key>, toLabel:
 * 'FILE', toKey: op.file, properties: {} }`, after the op's own edges. Pure: a new op, the input
 * untouched. With no MODULE row it returns the same op and `attached: false`: the caller warns.
 */
export function attachSourceFile(_op: ReplaceFileOp): {
  readonly op: ReplaceFileOp;
  readonly attached: boolean;
} {
  throw new Error('SEAT: attachSourceFile lands in U6a.3-2 (C-EXTRACT Q8)');
}

export interface CodeTierOptions {
  /** The engine's frozen registry, the one its walker routes with. */
  readonly registry: LanguageRegistry;
  readonly extractor: Extractor;
  /** Called at most once, on the first `run` (decision 100). */
  readonly createParseService: (options: ParseServiceOptions) => ParseService;
  /**
   * The front door's grammar directory: the locator's `explicit` rule (C-PARSE I11). Absent: the
   * grammar package's own directory (the package anchor).
   */
  readonly grammarDir?: string;
}

/** One file's code tier. `code` is the ParseError or ExtractOutcome code, or `truncated`/`internal`. */
export type CodeTierResult =
  | { readonly kind: 'extracted'; readonly file: ExtractedFile }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export interface CodeTier {
  /** True iff `language` is one of `extractor.grammars` (decision 96: the code tier runs only there). */
  covers(language: string | null): boolean;
  /**
   * One walked file of a covered language, from the walker's bytes. Never throws. In order:
   * 1. On the first call only: `createParseService({ registry, source })`, with `source` =
   *    `createDiskGrammarSource(pkg => resolveGrammarDir({ packageName: pkg, explicit: grammarDir,
   *    resolvePackageJson: p => require.resolve(`${p}/package.json`) }))` (`explicit` omitted when
   *    `grammarDir` is). Every later call reuses that service.
   * 2. `text = decodeSource(bytes)`, then `parse({ key: file.path, text, language: file.language })`.
   *    `ok: false` is `failed` with the ParseError's code and message.
   * 3. `extract({ path: file.path, grammarId: file.language, root: handle.root, revision_id:
   *    file.revision_id, lineCount: lineCountOf(text) })`, no tiers, no budget. The handle is
   *    released in a `finally`, before `run` resolves, so no two trees are ever live.
   * 4. `ok` is `extracted` with its file; `truncated` is `failed` `truncated` (its limit in the
   *    message); `failed` is `failed` with its code and message; a throw from parse or extract is
   *    `failed` `internal` with the thrown message.
   */
  run(file: WalkedFile & { readonly language: string }, bytes: Uint8Array): Promise<CodeTierResult>;
}

export function createCodeTier(_options: CodeTierOptions): CodeTier {
  throw new Error('SEAT: createCodeTier lands in U6a.3-2 (controller decisions 96, 100)');
}
