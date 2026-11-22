// @cpg/sink. REAL: makeDelta, sinkError, classifyFailure, assertDeltaWellFormed and the
// MemoryStore GraphSink half. SEAT: the SinkDelivery half (createSinkDelivery, retry, telemetry)
// arrives with its first caller. contract.ts stays types only (check-deps rule contract-types-only).
export type * from './contract';
export { assertDeltaWellFormed, classifyFailure, makeDelta, sinkError } from './delta';
export { createMemoryStore } from './memory-store';
export type { MemoryStore, MemoryStoreOptions } from './memory-store';
