// @cpg/parse. REAL: the language registry, ParseService over web-tree-sitter. SEAT: the
// retained-tree cache (ParseService.retain / releaseDocument throw until a caller exists).
export type * from './contract';
export { BUILTIN_LANGUAGES, createLanguageRegistry } from './registry';
export { createParseService, HandleReleasedError } from './service';
export type { ParseServiceOptions } from './service';
