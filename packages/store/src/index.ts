// @cpg/store. contract.ts is the C-STORE seam (types only); error.ts builds and reads StoreError;
// write-op.ts builds the code tier's replace-file (toWriteOp).
// SEAT: the Cypher planner, FalkorStore and bootstrap (U5).
export type * from './contract';
export { storeError, storeErrorCode } from './error';
export { toWriteOp } from './write-op';
