// SEAT (U3.1.1 part 1, BMO-52): the VS Code panel's GraphHost. Plain node, no vscode import. It will
// port 21754b4:src/views/graphViewProvider.ts (the ready handshake, merge locally and post only the
// delta) onto C-EXT's protocol.

import type {
  Epoch,
  GraphDelta,
  GraphPayload,
  Seq,
  ThemeSnapshot,
  VerificationReport,
  WebviewToHost,
} from '@cpg/model';
import type {
  DeltaMeta,
  FilesystemProbe,
  GraphHost,
  ProtocolFault,
  RevealOutcome,
  SnapshotMeta,
  WebviewTransport,
} from './contract';

export type RenderReportMessage = Extract<WebviewToHost, { type: 'render-report' }>;

export interface GraphHostOptions {
  /** The theme until setTheme replaces it, so one always precedes the first graph (C-EXT I-4). */
  readonly theme: ThemeSnapshot;
  /** One inbound message as its C-EXT type, or undefined. The host acts only on what this returns. */
  readonly parse: (message: unknown) => WebviewToHost | undefined;
}

const seat = (): never => {
  throw new Error('SEAT: PanelGraphHost lands with U3.1.1 part 1');
};

/**
 * The VS Code panel's GraphHost: one merged payload, its epoch, and at most one page kept in step.
 *
 * From the engine (GraphSink; each resolves on merge, I-11):
 * - `onSnapshot` 'initial' replaces the payload and bumps the epoch (I-13). 'catch-up' replaces it and
 *   keeps the epoch, when its seq is ahead of the payload held or there is none; at or behind it, it
 *   changes nothing (I-12: seq strictly increases per epoch). A snapshot taken is posted as `graph`.
 * - `onDelta` merges with applyGraphDelta (I-8) and posts the delta, edge-only included (I-6).
 *   Already-applied: nothing. A gap: a recorded seq-gap fault, and the promise resolves. Malformed:
 *   rejects with `malformed delta at seq <n>: <code> <nodeId>[, ...]`, because ProtocolFault has no
 *   kind for it. In the last three the payload is kept and nothing is posted. Before any snapshot the
 *   payload is the empty one at seq -1 (C-MODEL), so a first delta at seq 0 applies; a page already
 *   waiting for its graph is then posted that graph, not the delta.
 *
 * The seq of a `graph` is its payload's and of a `graph-delta` its delta's (controller decision 18);
 * `meta.seq` restates it (decision 28). Nothing is posted before the page's `ready` (I-2).
 *
 * From the page, through `options.parse`:
 * - `ready` at CPG_PROTOCOL_VERSION is answered with `theme`, then one `graph` of the merged payload
 *   (I-3, I-4), or with `theme` alone while there is no graph yet, which follows when it arrives. A
 *   second `ready` is a reloaded page and gets the same answer;
 * - `resync` from a ready page is answered with one `graph`, whatever epoch and seq it carries. From
 *   a page not ready, or with no graph yet, nothing;
 * - `render-report` at the host's epoch is kept as the latest (renderReport). At another epoch it is
 *   a bad-epoch fault and is not kept;
 * - `reveal` is ignored until part 2 (SEAT);
 * - what parse refuses, and a `ready` at another protocol, is an unknown-message fault holding the
 *   message as received.
 *
 * A `post` that throws is a post-failed fault with the message's seq (a `theme` has none: the host's
 * seq()) and the error as `{ name, message }`; a thrown non-Error is `{ name: 'Error', message:
 * String(thrown) }`. Nothing else changes, and later messages are still posted.
 */
export class PanelGraphHost implements GraphHost {
  protected readonly options: GraphHostOptions;

  constructor(options: GraphHostOptions) {
    this.options = options;
  }

  async onSnapshot(_payload: GraphPayload, _meta: SnapshotMeta): Promise<void> {
    seat();
  }

  async onDelta(_delta: GraphDelta, _meta: DeltaMeta): Promise<void> {
    seat();
  }

  /**
   * Makes `transport` the page this host talks to. An earlier one is unsubscribed and gets nothing
   * more (C-EXT not_guaranteed: multiplexing). The new page is not ready until it says so.
   */
  attach(_transport: WebviewTransport): void {
    seat();
  }

  /** Unsubscribes from the page and posts nothing more. The graph is kept, and deltas still merge. */
  detach(): void {
    seat();
  }

  /** The merged payload; before anything is delivered, the empty one at seq -1. */
  snapshot(): GraphPayload {
    return seat();
  }

  /** The merged payload's seq. */
  seq(): Seq {
    return seat();
  }

  /** 0 before the first 'initial' snapshot. */
  epoch(): Epoch {
    return seat();
  }

  /** SEAT: part 2 (C-EXT I-15 to I-17). */
  async reveal(_nodeId: string): Promise<RevealOutcome> {
    return seat();
  }

  /** Posts `theme` alone to a ready page (I-4); every later connection starts with it. */
  setTheme(_theme: ThemeSnapshot): void {
    seat();
  }

  /** SEAT: part 2 (C-EXT I-18, I-19, I-22). */
  async verify(_fs: FilesystemProbe): Promise<VerificationReport> {
    return seat();
  }

  /**
   * The latest render-report at the current epoch from the page now showing, or undefined: verify's
   * input for render-reconciliation (part 2). Gone after attach, detach, `ready` and an 'initial'
   * snapshot, because a page that has not drawn the graph since then has reported nothing (I-19).
   */
  renderReport(): RenderReportMessage | undefined {
    return seat();
  }

  /** Every fault so far, oldest first. */
  faults(): readonly ProtocolFault[] {
    return seat();
  }

  /** detach. */
  dispose(): void {
    seat();
  }
}
