// SEAT (U2b.1 part 2b, BMO-35): the cosmos.gl config from 21754b4:packages/graph-visualizer/src/visualizer.ts
// (the constructor's `new Graph(container, { ... })`).

import type { GraphConfig } from '@cosmos.gl/graph' with { 'resolution-mode': 'import' };
import type { SurfaceEvents } from './visualizer';

/**
 * The config the page constructs cosmos.gl's Graph with: the archive's physics, sizing and hover
 * settings, with the visualizer's `events` as the callbacks. Its colour literals are the archive's,
 * kept under stop-list 45.
 */
export function graphConfig(_events: SurfaceEvents): GraphConfig {
  throw new Error('SEAT: graphConfig is U2b.1 part 2b');
}
