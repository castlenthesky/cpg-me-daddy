// @cpg/parse. REAL: the language registry, ParseService over web-tree-sitter. SEAT: the ABI gate
// (abi.ts) and the grammar-dir locator (grammar-dir.ts) until U6a.1-close's implementation; the
// retained-tree cache (ParseService.retain / releaseDocument throw until a caller exists).
export type * from './contract';
export { AbiNotReadyError } from './abi';
export type { ParserRuntime } from './abi';
export { resolveGrammarDir } from './grammar-dir';
export { BUILTIN_LANGUAGES, createLanguageRegistry } from './registry';
export { createParseService, HandleReleasedError } from './service';
export type { ParseServiceOptions } from './service';
