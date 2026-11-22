// NullGraphStore: backs --dry-run (03-architecture §5). It counts what each write would touch and
// persists nothing, so every read is empty. It lives in the engine, never in a front door (C-CLI).

import type { GraphStore } from '@cpg/store';

export function createNullGraphStore(): GraphStore {
  // SEAT
  throw new Error('SEAT: createNullGraphStore');
}
