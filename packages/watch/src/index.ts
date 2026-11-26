// @cpg/watch. REAL: the @parcel/watcher backend (layer A), coalesce/flushBatch (layer B's pure core,
// U4.1.2), and ChangeBatcher, isExcludedPath/pairFileRenames, SerialQueue and withRetry (U4.1.1).
// SEAT: createWatchSession until U4.1.2 part a lands. contract.ts stays types only (check-deps rule
// contract-types-only).
export type * from './contract';
export { coalesce, flushBatch, type CoalesceOp, type PendingChange } from './coalesce';
export { ChangeBatcher, type ChangeBatcherOptions } from './debounce';
export { isExcludedPath, pairFileRenames, type Admit, type KnownRevision } from './normalize';
export { createParcelWatchBackend } from './parcel-backend';
export type { ParcelBackendOptions, ParcelModule } from './parcel-backend';
export { SerialQueue, withRetry, type RetryOptions, type SerialQueueOptions } from './queue';
export { createWatchSession } from './session';
