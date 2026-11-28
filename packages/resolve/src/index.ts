// @cpg/resolve. SEAT (U6c.1a): ChainResolver, NullResolver (a PASSTHROUGH control once real),
// createDefinitionLookup, applyResolutions, unresolved. REAL: the LSP stdio transport (framing +
// JSON-RPC connection over ProcessHost), the first piece of the U8 driver.
export type * from './contract';
export { applyResolutions } from './apply';
export { ChainResolver } from './chain';
export { createDefinitionLookup } from './lookup';
export { NullResolver } from './null';
export { unresolved } from './resolution';
export { createLspConnection } from './lsp/connection';
export type { LspConnection, LspConnectionOptions, RpcOutcome } from './lsp/connection';
export { createFrameDecoder, encodeMessage } from './lsp/framing';
export type { FrameEvent } from './lsp/framing';
