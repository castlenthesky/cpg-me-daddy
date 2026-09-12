/** Parsing: the grammar registry, the ABI gate and the backend seam (F4). */
export { AbiError, type AbiRange, assertAbiCompatible, requireAbiRange } from "./abi";
export type { LoadedGrammar, ParsedSource, ParserBackend } from "./backend";
export {
  EXTENSION_TO_GRAMMAR,
  GRAMMAR_IDS,
  GRAMMARS,
  type GrammarId,
  type GrammarSpec,
  grammarForExtension,
  grammarForPath,
  isGrammarId,
} from "./grammars";
export { GRAMMAR_DIR_ENV, resolveGrammarDir } from "./wasm-locator";
export { WebTreeSitterBackend, type WebTreeSitterBackendOptions } from "./web-tree-sitter-backend";
