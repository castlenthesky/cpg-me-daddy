/**
 * The named graph digest (C-SINK Q5): FNV-1a (32-bit) over a sorted projection of the nodes and
 * edges, so two processes holding the same graph agree whatever order they hold it in (INV-15).
 * Spelled `fnv1a32:<8 hex>` so a later algorithm change is visible in the value itself.
 */

import type { GraphPayload } from './index';

export function graphDigest(_graph: Pick<GraphPayload, 'nodes' | 'edges'>): string {
  // SEAT: U2a.2b
  throw new Error('SEAT: graphDigest is not built yet (U2a.2b)');
}
