/**
 * The declarations extraction entrypoint: parser backend + language adapter
 * + one file in, one `GraphDelta` out.
 *
 * Owns tree disposal. `ParserBackend`'s own docs say the caller owns the
 * returned tree and must release it (M1.3 gates wasm memory) — `extractFile`
 * is the caller, so it is the one place that must not leak. Disposal is
 * duck-typed (`disposeIfPossible`) rather than added to `ParserBackend`
 * itself: `TTree` is backend-specific and F4 deliberately kept the seam
 * tiny, so a backend that happens to expose `.delete()` (as `web-tree-sitter`'s
 * `Tree` does) gets released; a future backend with no such concept costs
 * this function nothing to support.
 */
import type { ParserBackend } from "../parser/backend";
import type { GraphDelta } from "../schema/validate";
import type { LanguageAdapter } from "./adapter";
import type { SyntaxNode } from "./syntax";
import { extractDeclarations } from "./walk";

export interface SourceFile {
  /** Workspace-relative path — becomes every node's `file` and the id prefix. */
  readonly path: string;
  readonly text: string;
}

function disposeIfPossible(tree: unknown): void {
  if (
    typeof tree === "object" &&
    tree !== null &&
    "delete" in tree &&
    typeof (tree as { delete: unknown }).delete === "function"
  ) {
    (tree as { delete(): void }).delete();
  }
}

/** Parses `file` with `adapter`'s grammar and walks it into a declarations `GraphDelta`. */
export async function extractFile<TTree extends { rootNode: SyntaxNode }>(
  backend: ParserBackend<TTree>,
  adapter: LanguageAdapter,
  file: SourceFile,
): Promise<GraphDelta> {
  const parsed = await backend.parse(adapter.grammarId, file.text);
  try {
    return extractDeclarations({ path: file.path, root: parsed.tree.rootNode, adapter });
  } finally {
    disposeIfPossible(parsed.tree);
  }
}

export {
  type ContainerKind,
  type DeclarationInfo,
  type LanguageAdapter,
  type MemberInfo,
  type MethodInfo,
  type ParamInfo,
  type TypeDeclInfo,
} from "./adapter";
export { DeltaBuilder } from "./delta";
export { pythonAdapter } from "./python";
export { formatRange, type SourcePoint } from "./range";
export { adapterFor, SUPPORTED_GRAMMAR_IDS } from "./registry";
export type { SyntaxNode, SyntaxPoint } from "./syntax";
export { makeTypeScriptAdapter, tsxAdapter, typeScriptAdapter } from "./typescript";
export { extractDeclarations, type ExtractDeclarationsInput } from "./walk";
