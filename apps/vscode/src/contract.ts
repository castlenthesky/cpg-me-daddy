// C-EXT's host-side types (05-contracts.yaml, C-EXT; U3.1.1 part 1, BMO-52), types only. The message
// unions, ThemeSnapshot and VerificationReport are @cpg/model's, shared with the browser inspector.

import type {
  Epoch,
  GraphDelta,
  GraphPayload,
  HostToWebview,
  Seq,
  SourceRange,
  ThemeSnapshot,
  VerificationReport,
  WorkspacePath,
} from '@cpg/model';

export interface SnapshotMeta {
  readonly seq: Seq;
  readonly cause: 'initial' | 'catch-up';
}

export interface DeltaMeta {
  readonly seq: Seq;
  readonly cause: 'live' | 'cascade' | 'bulk';
}

/**
 * What delivers the graph to a host. Not C-SINK's GraphSink, whose snapshot causes also include
 * 'resync' and which owns inspect and dispose (controller decision 28). Both calls resolve on merge,
 * never on paint (I-11).
 */
export interface GraphSink {
  onSnapshot(payload: GraphPayload, meta: SnapshotMeta): Promise<void>;
  onDelta(delta: GraphDelta, meta: DeltaMeta): Promise<void>;
}

export interface Disposable {
  dispose(): void;
}

/** How the host reaches one page. `onMessage` hands over parsed JSON, not yet validated. */
export interface WebviewTransport {
  /** LOSSY by contract: nothing here says the page got it. */
  post(message: HostToWebview): void;
  onMessage(handler: (message: unknown) => void): Disposable;
  readonly cspSource: string;
}

/** Opens a node's source in the editor; rejects when it cannot. */
export interface SourceOpener {
  open(request: {
    readonly filePath: WorkspacePath;
    /** Where the cursor goes; absent: the file opens whole. */
    readonly selection?: SourceRange;
    /** The extent to bring into view. */
    readonly frame?: SourceRange;
  }): Promise<void>;
}

/** The workspace's files, as the walker admits them (controller decision 29). */
export interface FilesystemProbe {
  listFiles(): Promise<WorkspacePath[]>;
  /** The content digest, or undefined when there is no such file or it can't be read. */
  digest(filePath: WorkspacePath): Promise<string | undefined>;
}

/** An error as plain data. C-EXT names the type and gives it no fields. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
}

/** Every reveal's result (I-16). */
export type RevealOutcome =
  | {
      readonly ok: true;
      readonly filePath: WorkspacePath;
      readonly target: 'nameRange' | 'range' | 'whole-file';
    }
  | { readonly ok: false; readonly reason: 'unknown-node'; readonly nodeId: string }
  | { readonly ok: false; readonly reason: 'no-location'; readonly nodeId: string }
  | {
      readonly ok: false;
      readonly reason: 'open-failed';
      readonly nodeId: string;
      readonly filePath: WorkspacePath;
      readonly error: SerializedError;
    };

/** Something the protocol forbids or lost, recorded instead of thrown. */
export type ProtocolFault =
  | { readonly kind: 'unknown-message'; readonly received: unknown }
  | { readonly kind: 'bad-epoch'; readonly expected: Epoch; readonly received: Epoch }
  | { readonly kind: 'seq-gap'; readonly expected: Seq; readonly received: Seq }
  | { readonly kind: 'post-failed'; readonly seq: Seq; readonly error: SerializedError };

/** Plain node: holds the authoritative merged graph and keeps one page in step with it. */
export interface GraphHost extends GraphSink {
  attach(transport: WebviewTransport): void;
  detach(): void;
  snapshot(): GraphPayload;
  seq(): Seq;
  epoch(): Epoch;
  reveal(nodeId: string): Promise<RevealOutcome>;
  setTheme(theme: ThemeSnapshot): void;
  verify(fs: FilesystemProbe): Promise<VerificationReport>;
  faults(): readonly ProtocolFault[];
  dispose(): void;
}
