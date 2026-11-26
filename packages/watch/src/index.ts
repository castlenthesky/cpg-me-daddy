// @cpg/watch. REAL: the @parcel/watcher backend (layer A) and coalesce/flushBatch (layer B's pure core,
// U4.1.2). SEAT: the session until U4.1.2 completes. contract.ts stays types only (check-deps rule
// contract-types-only).
export type * from './contract';
export { coalesce, flushBatch, type CoalesceOp, type PendingChange } from './coalesce';
export { createParcelWatchBackend } from './parcel-backend';
export type { ParcelBackendOptions, ParcelModule } from './parcel-backend';
