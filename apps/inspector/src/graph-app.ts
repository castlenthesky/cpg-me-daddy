// REAL (U2b.1 part 2b, BMO-35): port of 21754b4:src/webview/graphApp.ts.

import type { GraphDelta, GraphPayload, HostToWebview, WebviewToHost } from '@cpg/model';
import { mountGraphViews, type ViewDocument, type ViewElement } from './dom-views';
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGraphPayload(value: unknown): value is GraphPayload {
  return isRecord(value) && Array.isArray(value['nodes']) && Array.isArray(value['edges']);
}

function isGraphDelta(value: unknown): value is GraphDelta {
  return (
    isRecord(value) &&
    Array.isArray(value['addedNodes']) &&
    Array.isArray(value['addedEdges']) &&
    Array.isArray(value['removedNodeIds'])
  );
}

function isHostMessage(message: unknown): message is HostToWebview {
  if (!isRecord(message)) return false;
  if (message['type'] === 'graph') return isGraphPayload(message['payload']);
  if (message['type'] === 'graph-delta') return isGraphDelta(message['delta']);
  return false;
}

/**
 * Mounts the views, builds the visualizer, routes `graph` and `graph-delta` messages to it (anything
 * else is ignored), posts `reveal` with only the node id on a click, and posts `ready` last, once the
 * handler is registered, even when the surface failed to build.
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

  channel.onMessage((message) => {
    if (!isHostMessage(message)) return;
    if (message.type === 'graph') {
      visualizer.render(message.payload);
    } else {
      visualizer.applyDelta(message.delta);
    }
  });

  // Tells the host it is now safe to postMessage — a message sent right after the page HTML is set
  // can otherwise arrive before the listener above exists.
  channel.post({ type: 'ready' });
  return visualizer;
}
