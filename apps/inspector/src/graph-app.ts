// SEAT (U2b.1 part 2b, BMO-35): port of 21754b4:src/webview/graphApp.ts.

import type { WebviewToHost } from '@cpg/model';
import type { ViewDocument, ViewElement } from './dom-views';
import type { GraphSurface, GraphVisualizer, SurfaceEvents } from './visualizer';

/**
 * How the page talks to its host: the VS Code webview API (U3) or the inspector's WebSocket
 * (part 3). Typed as WebviewToHost so the page cannot post a message the host has no case for.
 */
export interface PageChannel {
  post(message: WebviewToHost): void;
  onMessage(handler: (message: unknown) => void): void;
}

/** Fixed, so two loads of the same payload seed the same picture (BMO-35 line 1). */
export const PAGE_SEED = 0;

export interface GraphPage<E extends ViewElement<E>> {
  readonly document: ViewDocument<E>;
  /** The element the views and cosmos.gl's canvas mount on. */
  readonly container: E;
  /** Builds the cosmos.gl Graph on the container with these callbacks (see graphConfig). */
  readonly makeSurface: (events: SurfaceEvents) => GraphSurface;
}

/**
 * Mounts the views, builds the visualizer, routes `graph` and `graph-delta` messages to it (anything
 * else is ignored), posts `reveal` with only the node id on a click, and posts `ready` last, once the
 * handler is registered, even when the surface failed to build.
 */
export function startGraphApp<E extends ViewElement<E>>(
  _page: GraphPage<E>,
  _channel: PageChannel,
): GraphVisualizer {
  throw new Error('SEAT: startGraphApp is U2b.1 part 2b');
}
