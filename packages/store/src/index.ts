// @cpg/store. contract.ts is the C-STORE seam (types only); error.ts builds and reads StoreError.
// SEAT: the Cypher planner, FalkorStore and bootstrap (U5).
export type * from './contract';
export { storeError, storeErrorCode } from './error';
