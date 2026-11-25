// REAL (U3.1.1 part 1, BMO-52): the VS Code panel's GraphHost. Plain node, no vscode import. Ports
// 21754b4:src/views/graphViewProvider.ts (ready handshake, merge locally and post only the delta,
// id-only reveal against the host's payload) onto C-EXT's protocol. SEAT (part 2): `reveal`, `verify`
// and the `onChange` calls. Product code does not call `onDelta` before U4 (controller decision 28).

import {
  applyGraphDelta,
  CPG_PROTOCOL_VERSION,
  type Epoch,
  type GraphDelta,
  type GraphPayload,
  type HostToWebview,
  type Seq,
  type ThemeSnapshot,
  type VerificationReport,
  type WebviewToHost,
} from '@cpg/model';
import type {
  DeltaMeta,
  FilesystemProbe,
  GraphHost,
  ProtocolFault,
  RevealOutcome,
  SnapshotMeta,
  SourceOpener,
  WebviewTransport,
} from './contract';
import { serializeError } from './errors';

export type RenderReportMessage = Extract<WebviewToHost, { type: 'render-report' }>;

export interface GraphHostOptions {
  /** The theme until setTheme replaces it, so one always precedes the first graph (C-EXT I-4). */
  readonly theme: ThemeSnapshot;
  /** One inbound message as its C-EXT type, or undefined. The host acts only on what this returns. */
  readonly parse: (message: unknown) => WebviewToHost | undefined;
  /** What reveal opens a node's source with. */
  readonly opener: SourceOpener;
  /**
   * The outcome of each `reveal` from the page, once, dispose or not (controller decision 37). What
   * it throws or rejects with changes nothing in the host.
   */
  readonly onReveal: (outcome: RevealOutcome) => void;
  /**
   * Called after a snapshot or a delta has changed the payload, and after a render-report is
   * accepted (controller decision 36): VerifyScheduler.changed. Nothing else calls it.
   */
  readonly onChange: () => void;
}

const EMPTY_PAYLOAD: GraphPayload = { seq: -1, nodes: [], edges: [] };

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
 * - `reveal` is `reveal(nodeId)` and its outcome goes to `options.onReveal`. Only the id is read: any
 *   location-shaped field is ignored (I-17), and nothing is posted or recorded for it;
 * - what parse refuses, and a `ready` at another protocol, is an unknown-message fault holding the
 *   message as received.
 *
 * A `post` that throws is a post-failed fault with the message's seq (a `theme` has none: the host's
 * seq()) and the error as `{ name, message }`; a thrown non-Error is `{ name: 'Error', message:
 * String(thrown) }`. Nothing else changes, and later messages are still posted.
 */
export class PanelGraphHost implements GraphHost {
  private readonly options: GraphHostOptions;
  private currentPayload: GraphPayload | undefined;
  private currentEpoch: Epoch = 0;
  private currentTheme: ThemeSnapshot;
  private transport: WebviewTransport | undefined;
  private subscription: ReturnType<WebviewTransport['onMessage']> | undefined;
  private ready = false;
  private latestRenderReport: RenderReportMessage | undefined;
  private readonly recordedFaults: ProtocolFault[] = [];

  constructor(options: GraphHostOptions) {
    this.options = options;
    this.currentTheme = options.theme;
  }

  async onSnapshot(payload: GraphPayload, meta: SnapshotMeta): Promise<void> {
    if (meta.cause === 'initial') {
      this.currentEpoch += 1;
      this.latestRenderReport = undefined;
    } else if (this.currentPayload !== undefined && payload.seq <= this.currentPayload.seq) {
      return;
    }
    this.currentPayload = payload;
    this.postGraph();
  }

  async onDelta(delta: GraphDelta, _meta: DeltaMeta): Promise<void> {
    const hadGraph = this.currentPayload !== undefined;
    const result = applyGraphDelta(this.currentPayload ?? EMPTY_PAYLOAD, delta);
    switch (result.outcome) {
      case 'applied':
        this.currentPayload = result.payload;
        if (hadGraph) {
          this.post({
            type: 'graph-delta',
            protocol: CPG_PROTOCOL_VERSION,
            epoch: this.currentEpoch,
            seq: delta.seq,
            delta,
          });
        } else {
          this.postGraph();
        }
        return;
      case 'already-applied':
        return;
      case 'gap':
        this.recordedFaults.push({
          kind: 'seq-gap',
          expected: result.expected,
          received: result.got,
        });
        return;
      case 'malformed': {
        const defects = result.defects
          .map((defect) => `${defect.code} ${defect.nodeId}`)
          .join(', ');
        throw new Error(`malformed delta at seq ${String(delta.seq)}: ${defects}`);
      }
    }
  }

  /**
   * Makes `transport` the page this host talks to. An earlier one is unsubscribed and gets nothing
   * more (C-EXT not_guaranteed: multiplexing). The new page is not ready until it says so.
   */
  attach(transport: WebviewTransport): void {
    this.detach();
    this.transport = transport;
    this.subscription = transport.onMessage((message) => this.handleMessage(message));
  }

  /** Unsubscribes from the page and posts nothing more. The graph is kept, and deltas still merge. */
  detach(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.transport = undefined;
    this.ready = false;
    this.latestRenderReport = undefined;
  }

  /** The merged payload; before anything is delivered, the empty one at seq -1. */
  snapshot(): GraphPayload {
    return this.currentPayload ?? EMPTY_PAYLOAD;
  }

  /** The merged payload's seq. */
  seq(): Seq {
    return this.snapshot().seq;
  }

  /** 0 before the first 'initial' snapshot. */
  epoch(): Epoch {
    return this.currentEpoch;
  }

  /**
   * Opens the source of the node `nodeId` names in the merged payload (I-15) and says what happened
   * (I-16); never rejects. SEAT.
   * - A FILE opens whole, at its `path` property and whatever its `data.location` says.
   * - Any other node opens at its `data.location` (readNodeLocation): the cursor on `nameRange`, or on
   *   `range` when there is none, with `range` framed.
   * - `unknown-node`: no node has that id. `no-location`: the node has no location, a malformed one, or
   *   is a FILE whose `path` is not a file's workspace path. Neither opens anything.
   * - `open-failed`: the opener threw or rejected.
   */
  async reveal(_nodeId: string): Promise<RevealOutcome> {
    throw new Error('SEAT: PanelGraphHost.reveal lands with U3.1.1 part 2');
  }

  /** Posts `theme` alone to a ready page (I-4); every later connection starts with it. */
  setTheme(theme: ThemeSnapshot): void {
    this.currentTheme = theme;
    this.postTheme();
  }

  /**
   * The six checks over the payload, epoch and render-report held when it is called (verifyPayload,
   * I-18): what lands while it runs makes the report's seq or epoch lag and is not judged. Every
   * completed run is posted as a `verification` carrying its report's epoch and seq (I-22), to a page
   * that is ready then (I-2); after dispose it posts nothing. Never rejects. SEAT.
   */
  async verify(_fs: FilesystemProbe): Promise<VerificationReport> {
    throw new Error('SEAT: PanelGraphHost.verify lands with U3.1.1 part 2');
  }

  /**
   * The latest render-report at the current epoch from the page now showing, or undefined: verify's
   * input for render-reconciliation. Gone after attach, detach, `ready` and an 'initial'
   * snapshot, because a page that has not drawn the graph since then has reported nothing (I-19).
   */
  renderReport(): RenderReportMessage | undefined {
    return this.latestRenderReport;
  }

  /** Every fault so far, oldest first. */
  faults(): readonly ProtocolFault[] {
    return [...this.recordedFaults];
  }

  /** detach. */
  dispose(): void {
    this.detach();
  }

  private postTheme(): void {
    this.post({
      type: 'theme',
      protocol: CPG_PROTOCOL_VERSION,
      epoch: this.currentEpoch,
      theme: this.currentTheme,
    });
  }

  /** The whole merged graph, if there is one. */
  private postGraph(): void {
    if (this.currentPayload === undefined) return;
    this.post({
      type: 'graph',
      protocol: CPG_PROTOCOL_VERSION,
      epoch: this.currentEpoch,
      seq: this.currentPayload.seq,
      payload: this.currentPayload,
    });
  }

  /** The one place a message leaves: dropped unless the attached page is ready (I-2). */
  private post(message: HostToWebview): void {
    if (this.transport === undefined || !this.ready) return;
    try {
      this.transport.post(message);
    } catch (thrown) {
      const seq = message.type === 'theme' ? this.seq() : message.seq;
      this.recordedFaults.push({ kind: 'post-failed', seq, error: serializeError(thrown) });
    }
  }

  private handleMessage(raw: unknown): void {
    const parsed = this.options.parse(raw);
    if (parsed === undefined) {
      this.recordedFaults.push({ kind: 'unknown-message', received: raw });
      return;
    }
    switch (parsed.type) {
      case 'ready':
        if (parsed.protocol !== CPG_PROTOCOL_VERSION) {
          this.recordedFaults.push({ kind: 'unknown-message', received: raw });
          return;
        }
        this.ready = true;
        this.latestRenderReport = undefined;
        this.postTheme();
        this.postGraph();
        return;
      case 'resync':
        this.postGraph();
        return;
      case 'render-report':
        if (parsed.epoch !== this.currentEpoch) {
          this.recordedFaults.push({
            kind: 'bad-epoch',
            expected: this.currentEpoch,
            received: parsed.epoch,
          });
          return;
        }
        this.latestRenderReport = parsed;
        return;
      case 'reveal':
        // SEAT (U3.1.1 part 2): inbound reveal opens source via SourceOpener.
        return;
    }
  }
}
