// REAL (U3.1.1 part 1, BMO-52; its own file since part 2): an error as plain data.

import type { SerializedError } from './contract';

/** A thrown non-Error is `{ name: 'Error', message: String(thrown) }`. */
export function serializeError(thrown: unknown): SerializedError {
  return thrown instanceof Error
    ? { name: thrown.name, message: thrown.message }
    : { name: 'Error', message: String(thrown) };
}
