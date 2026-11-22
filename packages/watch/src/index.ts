// @cpg/watch. REAL: the @parcel/watcher backend (layer A). SEAT: layer B (coalesce, flushBatch, the
// session) until U4.1.2. contract.ts stays types only (check-deps rule contract-types-only).
export type * from './contract';
export { createParcelWatchBackend } from './parcel-backend';
export type { ParcelBackendOptions, ParcelModule } from './parcel-backend';
