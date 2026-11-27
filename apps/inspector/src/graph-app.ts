// REAL (U2b.1 parts 2b and 3a-i, BMO-35): port of 21754b4:src/webview/graphApp.ts plus the C-EXT
// protocol (epoch, seq, resync), the render-report and the verification banner.

import {
  applyGraphDelta,
  CPG_PROTOCOL_VERSION,
  type GraphPayload,
  type WebviewToHost,
} from '@cpg/model';
import { verificationText } from './banner';
import { mountGraphViews, type ViewDocument, type ViewElement } from './dom-views';
import { parsePageMessage } from './messages';
import { renderReport } from './render-report';
import { GraphVisualizer, type GraphSurface, type SurfaceEvents } from './visualizer';

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
  /**
   * Re-reads the page's computed colours and gives them to the surface (controller decision 32).
   * Called on every `theme`; the visualizer takes the node colours itself.
   */
  readonly recolour?: () => void;
  /** The clock frameMs is measured on; performance.now() by default. */
  readonly now?: () => number;
}

/**
 * Mounts the views and builds the visualizer, then speaks C-EXT's protocol with the host:
 * - posts `ready` with CPG_PROTOCOL_VERSION last, once the handler is registered, even when the
 *   surface failed to build;
 * - takes only messages parsePageMessage accepts (protocol 1); everything else is ignored;
 * - `theme`: gives its node colours to the visualizer and calls `page.recolour`. It belongs to no
 *   graph: it changes neither the epoch nor the payload, and posts nothing;
 * - `graph`: adopts its epoch and payload, renders, and posts a render-report at its seq;
 * - `graph-delta`: before any graph, or on another epoch than the page's, posts resync 'stale-epoch';
 *   otherwise merges it into the held payload with applyGraphDelta: applied draws it and posts a
 *   render-report, already-applied is ignored, a gap posts resync 'gap', malformed posts resync
 *   'render-error'. A resync carries the page's own epoch and seq (0 and -1 before any graph);
 * - `verification`: writes verificationText into the banner, when its epoch is the page's (0 before
 *   any graph); another epoch's is ignored (controller decision 73, BMO-85). SEAT (U4.2.2): the epoch
 *   check is not built yet;
 * - a click posts `reveal` with only the node id.
 */
export function startGraphApp<E extends ViewElement<E>>(
  page: GraphPage<E>,
  channel: PageChannel,
): GraphVisualizer {
  const views = mountGraphViews(page.document, page.container, () => visualizer.fitView());
  const visualizer = new GraphVisualizer(page.makeSurface, views, {
    seed: PAGE_SEED,
    onNodeClick: (node) => channel.post({ type: 'reveal', nodeId: node.id }),
  });

  const now = page.now ?? (() => performance.now());
  let epoch = 0;
  let payload: GraphPayload | undefined;

  const postResync = (reason: 'gap' | 'stale-epoch' | 'render-error'): void => {
    channel.post({ type: 'resync', epoch, seq: payload?.seq ?? -1, reason });
  };

  const postReport = (seq: number, current: GraphPayload, frameMs: number): void => {
    channel.post({
      type: 'render-report',
      epoch,
      seq,
      report: renderReport(current, visualizer.drawn(), frameMs),
    });
  };

  channel.onMessage((raw) => {
    const message = parsePageMessage(raw);
    if (message === undefined) return;

    if (message.type === 'theme') {
      visualizer.setNodeColors(message.theme);
      page.recolour?.();
      return;
    }

    if (message.type === 'graph') {
      epoch = message.epoch;
      payload = message.payload;
      const t0 = now();
      visualizer.render(payload);
      const frameMs = now() - t0;
      postReport(message.seq, payload, frameMs);
      return;
    }

    if (message.type === 'verification') {
      page.banner.textContent = verificationText(message.report);
      return;
    }

    if (payload === undefined || message.epoch !== epoch) {
      postResync('stale-epoch');
      return;
    }

    const result = applyGraphDelta(payload, message.delta);
    switch (result.outcome) {
      case 'already-applied':
        return;
      case 'gap':
        postResync('gap');
        return;
      case 'malformed':
        postResync('render-error');
        return;
      case 'applied': {
        payload = result.payload;
        const t0 = now();
        visualizer.applyDelta(message.delta);
        const frameMs = now() - t0;
        postReport(message.seq, payload, frameMs);
        return;
      }
    }
  });

  // Tells the host it is now safe to postMessage — a message sent right after the page HTML is set
  // can otherwise arrive before the listener above exists.
  channel.post({ type: 'ready', protocol: CPG_PROTOCOL_VERSION });
  return visualizer;
}
