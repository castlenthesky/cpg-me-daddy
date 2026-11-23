// The inspector child process (owner decision 9a, U2b.1 part 3b). `cpg inspect` and
// `cpg index --inspect` start the cpg-inspector bin, write NDJSON to its stdin, and read its stdout:
// first the listening line, then each render-report. main.ts wires spawnInspector into run(), and
// run()'s tests pass a fake StartInspector.

import type { GraphPayload, VerificationReport, WebviewToHost } from '@cpg/model';

/**
 * One NDJSON line on the inspector's stdin, one of the bin's InspectorInput shapes. The CLI sends
 * one full graph and no deltas (controller decision 23). A verification carries all six checks,
 * once each, in enum order.
 */
export type InspectorLine =
  | { readonly type: 'graph'; readonly payload: GraphPayload }
  | { readonly type: 'verification'; readonly report: Omit<VerificationReport, 'epoch'> };

/** A render-report the page sent, as the inspector prints it on stdout (C-EXT WebviewToHost). */
export type RenderReportMessage = Extract<WebviewToHost, { type: 'render-report' }>;

/** How the child ended: its exit code, or the signal that ended it. */
export interface InspectorExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface InspectorHandlers {
  /** Each render-report line the child prints, in order. */
  readonly onRenderReport: (message: RenderReportMessage) => void;
}

/** The running inspector as run() sees it. */
export interface InspectorProcess {
  /** The page URL from the child's listening line: `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** Writes one NDJSON line to the child's stdin. A line after the child exits or stop() is dropped. */
  send(line: InspectorLine): void;
  /** Settles once the child has exited. */
  readonly exited: Promise<InspectorExit>;
  /**
   * Ends the child's stdin, which shuts it down, then SIGKILLs it if it has not exited within the
   * grace period. Resolves once it has exited. Idempotent.
   */
  stop(): Promise<void>;
}

/** Starts an inspector; resolves once its page URL is known. */
export type StartInspector = (handlers: InspectorHandlers) => Promise<InspectorProcess>;

export interface SpawnInspectorOptions extends InspectorHandlers {
  /**
   * A diagnostic line (main.ts passes io.err): `cpg: warning: the inspector printed a line that is
   * not a render-report: <line>`.
   */
  readonly log: (line: string) => void;
  /** How long the child may take to print its listening line before it is killed. Default 10000. */
  readonly startMs?: number;
  /** How long stop() waits after ending stdin before SIGKILL. Default 2000. */
  readonly graceMs?: number;
}

/**
 * The absolute path of the cpg-inspector bin: `require.resolve('@cpg/inspector/package.json')`
 * and that manifest's `bin['cpg-inspector']`, relative to it (controller decision 16). Resolving a
 * path loads no inspector code. Rejects when the package or its bin entry is missing.
 */
export async function resolveInspectorBin(): Promise<string> {
  // SEAT: U2b.1 part 3b
  throw new Error('SEAT: resolveInspectorBin (U2b.1 part 3b)');
}

/**
 * Runs `node <bin>` with stdin and stdout piped and stderr inherited, so the child's own
 * `cpg-inspector: ` lines reach the terminal. Resolves once the child's first stdout line is
 * `{"type":"listening","url":...}`. It rejects, and kills the child, when the child exits first,
 * when the first line is anything else, or when `startMs` passes first. After that, each stdout
 * line is a render-report for `onRenderReport`; any other line goes to `log`.
 */
export async function spawnInspector(
  bin: string,
  options: SpawnInspectorOptions,
): Promise<InspectorProcess> {
  // SEAT: U2b.1 part 3b
  throw new Error(`SEAT: spawnInspector ${bin} ${String(options.startMs)} (U2b.1 part 3b)`);
}
