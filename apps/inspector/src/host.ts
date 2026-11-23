// REAL (U2b.1 part 3a-ii, BMO-35): the browser inspector's GraphHost, reduced to what the picture
// needs. It ports the archive's ready handshake and merge-then-post-delta
// (21754b4:src/views/graphViewProvider.ts) onto C-EXT's protocol: the host holds the merged payload,
// owns the epoch, and posts nothing before ready.

import {
  applyGraphDelta,
  CPG_PROTOCOL_VERSION,
  type Epoch,
  type GraphPayload,
  type HostToWebview,
  type VerificationReport,
  type WebviewToHost,
} from '@cpg/model';
import { parseWebviewMessage, type InspectorInput } from './messages';

/** C-EXT Disposable (only the transport's subscriptions use it so far). */
interface Disposable {
  dispose(): void;
}

/**
 * C-EXT WebviewTransport: how a host reaches one page. `post` is lossy by contract and never
 * throws; `onMessage` hands over each inbound message as parsed JSON, not yet validated.
 */
export interface WebviewTransport {
  post(message: HostToWebview): void;
  onMessage(handler: (message: unknown) => void): Disposable;
  /** The source the page's style-src allows (C-EXT; the browser inspector's is `'self'`). */
  readonly cspSource: string;
}

export type RenderReportMessage = Extract<WebviewToHost, { type: 'render-report' }>;

export interface InspectorHostOptions {
  /** Each well-formed render-report from the attached page, whatever its epoch. */
  readonly onRenderReport: (message: RenderReportMessage) => void;
  /**
   * One line per fault (C-EXT I-12): `seq-gap: expected seq <n>, got <m>`,
   * `malformed delta at seq <m>: <the defects as JSON>`, `delta before any graph at seq <m>`, or
   * `unknown-message: <the message as JSON>`. The last covers a message parseWebviewMessage
   * rejects and a `ready` whose protocol is not CPG_PROTOCOL_VERSION.
   */
  readonly onFault: (line: string) => void;
}

function verificationMessage(report: VerificationReport): HostToWebview {
  return {
    type: 'verification',
    protocol: CPG_PROTOCOL_VERSION,
    epoch: report.epoch,
    seq: report.seq,
    report,
  };
}

/**
 * Holds the merged payload, the epoch and the latest verify report, and keeps one page in step.
 *
 * From stdin (`input`):
 * - `graph` replaces the payload and bumps the epoch (C-EXT I-13);
 * - `graph-delta` merges through applyGraphDelta (I-8). Applied: posted as itself (edge-only
 *   included, I-6). Already-applied: dropped (at-least-once). A gap, a malformed delta or a delta
 *   before any graph: a fault, not posted, and the payload is kept;
 * - `verification` is stamped with the current epoch and kept as the latest.
 *
 * Each is posted only once the page is ready (I-2). Every message carries protocol 1 and the host's
 * epoch. A graph's seq is its payload's, and a delta's is the delta's (controller decision 18). A
 * verification's message epoch and seq are its report's.
 *
 * From the page: `ready` at CPG_PROTOCOL_VERSION marks the page ready. It and a `resync` from a
 * ready page are answered with one `graph` of the merged payload if there is one (I-3, never a
 * replay), then the latest verification if there is one. A resync from a page not yet ready is not
 * answered (I-2). A render-report goes to `onRenderReport`; `reveal` is ignored (a browser has no
 * SourceOpener); anything else is an unknown-message fault.
 *
 * `attach` replaces the transport: the old subscription is disposed, and the new page is not ready
 * until it sends `ready` (C-EXT not_guaranteed: multiplexing).
 */
export class InspectorHost {
  private readonly options: InspectorHostOptions;
  private currentEpoch: Epoch = 0;
  private currentPayload: GraphPayload | undefined;
  private latestVerification: VerificationReport | undefined;
  private transport: WebviewTransport | undefined;
  private subscription: Disposable | undefined;
  private ready = false;

  constructor(options: InspectorHostOptions) {
    this.options = options;
  }

  /** The current epoch: 0 before the first graph. */
  epoch(): Epoch {
    return this.currentEpoch;
  }

  /** The merged payload, or undefined before the first graph. */
  snapshot(): GraphPayload | undefined {
    return this.currentPayload;
  }

  /** One stdin line, already parsed. */
  input(input: InspectorInput): void {
    switch (input.type) {
      case 'graph':
        this.currentPayload = input.payload;
        this.currentEpoch += 1;
        this.post(this.graphMessage(this.currentPayload));
        return;
      case 'graph-delta': {
        if (this.currentPayload === undefined) {
          this.options.onFault(`delta before any graph at seq ${String(input.delta.seq)}`);
          return;
        }
        const result = applyGraphDelta(this.currentPayload, input.delta);
        switch (result.outcome) {
          case 'applied':
            this.currentPayload = result.payload;
            this.post({
              type: 'graph-delta',
              protocol: CPG_PROTOCOL_VERSION,
              epoch: this.currentEpoch,
              seq: input.delta.seq,
              delta: input.delta,
            });
            return;
          case 'already-applied':
            return;
          case 'gap':
            this.options.onFault(
              `seq-gap: expected seq ${String(result.expected)}, got ${String(result.got)}`,
            );
            return;
          case 'malformed':
            this.options.onFault(
              `malformed delta at seq ${String(input.delta.seq)}: ${JSON.stringify(result.defects)}`,
            );
            return;
        }
      }
      case 'verification': {
        const report: VerificationReport = {
          epoch: this.currentEpoch,
          seq: input.report.seq,
          checks: input.report.checks,
          state: input.report.state,
        };
        this.latestVerification = report;
        this.post(verificationMessage(report));
        return;
      }
    }
  }

  /** Makes `transport` the page this host talks to, replacing any earlier one. */
  attach(transport: WebviewTransport): void {
    this.subscription?.dispose();
    this.transport = transport;
    this.ready = false;
    this.subscription = transport.onMessage((message) => this.handleMessage(message));
  }

  private graphMessage(payload: GraphPayload): HostToWebview {
    return {
      type: 'graph',
      protocol: CPG_PROTOCOL_VERSION,
      epoch: this.currentEpoch,
      seq: payload.seq,
      payload,
    };
  }

  private post(message: HostToWebview): void {
    if (this.transport !== undefined && this.ready) {
      this.transport.post(message);
    }
  }

  private answer(): void {
    if (this.currentPayload !== undefined) {
      this.post(this.graphMessage(this.currentPayload));
    }
    if (this.latestVerification !== undefined) {
      this.post(verificationMessage(this.latestVerification));
    }
  }

  private handleMessage(raw: unknown): void {
    const parsed = parseWebviewMessage(raw);
    if (parsed === undefined) {
      this.options.onFault(`unknown-message: ${JSON.stringify(raw)}`);
      return;
    }
    switch (parsed.type) {
      case 'ready':
        if (parsed.protocol !== CPG_PROTOCOL_VERSION) {
          this.options.onFault(`unknown-message: ${JSON.stringify(raw)}`);
          return;
        }
        this.ready = true;
        this.answer();
        return;
      case 'resync':
        if (this.ready) {
          this.answer();
        }
        return;
      case 'render-report':
        this.options.onRenderReport(parsed);
        return;
      case 'reveal':
        return;
    }
  }
}
