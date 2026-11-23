// @cpg/resolve. REAL: the LSP stdio transport (framing + JSON-RPC connection over ProcessHost), the
// first piece of the U8 driver. SEAT: every Resolver (types only in contract.ts) until U6c/U8.
export type * from './contract';
export { createLspConnection } from './lsp/connection';
export type { LspConnection, LspConnectionOptions, RpcOutcome } from './lsp/connection';
export { createFrameDecoder, encodeMessage } from './lsp/framing';
export type { FrameEvent } from './lsp/framing';
