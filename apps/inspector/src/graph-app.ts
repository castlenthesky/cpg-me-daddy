// REAL (U2b.1 part 2b, BMO-35): port of 21754b4:src/webview/graphApp.ts. SEAT (U2b.1 part 3a-i): the
// C-EXT protocol (epoch, seq, resync), the render-report and the verification banner.

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
  /** The shell's #cpg-verification region, which shows the latest verify report. */
  readonly banner: E;
  /** The clock frameMs is measured on; performance.now() by default. */
  readonly now?: () => number;
}

/**
 * Mounts the views and builds the visualizer, then speaks C-EXT's protocol with the host:
 * - posts `ready` with CPG_PROTOCOL_VERSION last, once the handler is registered, even when the
 *   surface failed to build;
 * - takes only messages parsePageMessage accepts (protocol 1); everything else is ignored;
 * - `graph`: adopts its epoch and payload, renders, and posts a render-report at its seq;
 * - `graph-delta`: before any graph, or on another epoch than the page's, posts resync 'stale-epoch';
 *   otherwise merges it into the held payload with applyGraphDelta: applied draws it and posts a
 *   render-report, already-applied is ignored, a gap posts resync 'gap', malformed posts resync
 *   'render-error'. A resync carries the page's own epoch and seq (0 and -1 before any graph);
 * - `verification`: writes verificationText into the banner;
 * - a click posts `reveal` with only the node id.
 */
export function startGraphApp<E extends ViewElement<E>>(
  _page: GraphPage<E>,
  _channel: PageChannel,
): GraphVisualizer {
  throw new Error('SEAT: the C-EXT page protocol is U2b.1 part 3a-i');
}
