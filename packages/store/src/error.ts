import type { StoreError, StoreErrorCode } from './contract';

export function storeError(_code: StoreErrorCode, _message: string): StoreError {
  // SEAT: U2a.2c
  throw new Error('SEAT: storeError is not built yet (U2a.2c)');
}

/** The StoreErrorCode of a StoreError, or undefined for anything else. */
export function storeErrorCode(_value: unknown): StoreErrorCode | undefined {
  // SEAT: U2a.2c
  throw new Error('SEAT: storeErrorCode is not built yet (U2a.2c)');
}
