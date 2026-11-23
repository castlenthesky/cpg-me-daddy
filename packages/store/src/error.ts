import type { StoreError, StoreErrorCode } from './contract';

const STORE_ERROR_CODES: Readonly<Record<StoreErrorCode, true>> = {
  STORE_NOT_OPEN: true,
  SCHEMA_INVALID: true,
  OWNERSHIP_VIOLATION: true,
  WRITE_SHAPE_VIOLATION: true,
  UNSAFE_DELETE_REFUSED: true,
  STRUCTURAL_TOKEN_REJECTED: true,
  CAPACITY: true,
  TIMEOUT: true,
  CONNECTION_LOST: true,
  BACKEND: true,
};

function isStoreErrorCode(value: unknown): value is StoreErrorCode {
  return typeof value === 'string' && Object.hasOwn(STORE_ERROR_CODES, value);
}

export function storeError(code: StoreErrorCode, message: string): StoreError {
  // REAL
  return Object.assign(new Error(message), { name: 'StoreError' as const, code });
}

/** The StoreErrorCode of a StoreError, or undefined for anything else. */
export function storeErrorCode(value: unknown): StoreErrorCode | undefined {
  // REAL
  if (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === 'StoreError' &&
    'code' in value &&
    isStoreErrorCode(value.code)
  ) {
    return value.code;
  }
  return undefined;
}
