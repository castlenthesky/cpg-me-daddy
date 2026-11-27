// @cpg/parse. REAL: the language registry, ParseService over web-tree-sitter, the ABI gate, the
// grammar-dir locator. SEAT: the retained-tree cache (ParseService.retain / releaseDocument throw
// until a caller exists).
export type * from './contract';
export { AbiNotReadyError } from './abi';
export type { ParserRuntime } from './abi';
export { resolveGrammarDir } from './grammar-dir';
export { BUILTIN_LANGUAGES, createLanguageRegistry } from './registry';
export { createParseService, HandleReleasedError } from './service';
export type { ParseServiceOptions } from './service';
