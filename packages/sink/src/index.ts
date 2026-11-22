// @cpg/sink. SEAT until U2a.2b lands: makeDelta, classifyFailure, assertDeltaWellFormed and the
// MemoryStore GraphSink. contract.ts stays types only (check-deps rule contract-types-only).
export type * from './contract';
export { assertDeltaWellFormed, classifyFailure, makeDelta, sinkError } from './delta';
export { createMemoryStore } from './memory-store';
export type { MemoryStore, MemoryStoreOptions } from './memory-store';
