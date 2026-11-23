// The inspector child process (owner decision 9a, U2b.1 part 3b). `cpg inspect` and
// `cpg index --inspect` start the cpg-inspector bin, write NDJSON to its stdin, and read its stdout:
// first the listening line, then each render-report. main.ts wires spawnInspector into run(), and
// run()'s tests pass a fake StartInspector.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { GraphPayload, RenderReport, VerificationReport, WebviewToHost } from '@cpg/model';

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

const DEFAULT_START_MS = 10_000;
const DEFAULT_GRACE_MS = 2000;

// A write to a child that closed its stdin while alive fails with EPIPE; that line is dropped.
const noop = (): void => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isListeningLine(
  value: unknown,
): value is { readonly type: 'listening'; readonly url: string } {
  return isRecord(value) && value['type'] === 'listening' && typeof value['url'] === 'string';
}

function isRenderReport(value: unknown): value is RenderReport {
  if (
    !isRecord(value) ||
    typeof value['payloadNodeCount'] !== 'number' ||
    typeof value['renderedNodeCount'] !== 'number' ||
    typeof value['renderedEdgeCount'] !== 'number' ||
    typeof value['duplicateEdges'] !== 'number' ||
    typeof value['frameMs'] !== 'number' ||
    !Array.isArray(value['droppedNodeIds'])
  ) {
    return false;
  }
  for (const entry of value['droppedNodeIds']) {
    if (typeof entry !== 'string') return false;
  }
  return true;
}

function isRenderReportMessage(value: unknown): value is RenderReportMessage {
  return (
    isRecord(value) &&
    value['type'] === 'render-report' &&
    typeof value['epoch'] === 'number' &&
    typeof value['seq'] === 'number' &&
    isRenderReport(value['report'])
  );
}

/**
 * The absolute path of the cpg-inspector bin: `require.resolve('@cpg/inspector/package.json')`
 * and that manifest's `bin['cpg-inspector']`, relative to it (controller decision 16). Resolving a
 * path loads no inspector code. Rejects when the package or its bin entry is missing.
 */
export async function resolveInspectorBin(): Promise<string> {
  // REAL
  const manifest = require.resolve('@cpg/inspector/package.json');
  const parsed = parseJson(await readFile(manifest, 'utf8'));
  const bin = isRecord(parsed) ? parsed['bin'] : undefined;
  const entry = isRecord(bin) ? bin['cpg-inspector'] : undefined;
  if (typeof entry !== 'string' || entry === '') {
    throw new Error(`${manifest} has no cpg-inspector bin`);
  }
  return join(dirname(manifest), entry);
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
  // REAL
  const startMs = options.startMs ?? DEFAULT_START_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const child = spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'inherit'] });

  let hasExited = false;
  const exited = new Promise<InspectorExit>((resolve) => {
    child.once('exit', (code, signal) => {
      hasExited = true;
      resolve({ code, signal });
    });
  });

  child.stdin.on('error', noop);
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  return new Promise<InspectorProcess>((resolve, reject) => {
    let settled = false;
    let started = false;
    let stopped = false;
    let stopPromise: Promise<void> | undefined;

    const failStart = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      rl.close();
      if (!hasExited) {
        child.kill('SIGKILL');
      }
      reject(error);
    };

    const startTimer = setTimeout(() => {
      failStart(new Error(`the inspector printed no listening line within ${String(startMs)} ms`));
    }, startMs);

    child.once('error', failStart);

    void exited.then(({ code, signal }) => {
      if (!settled) {
        const how = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
        failStart(new Error(`the inspector exited before its listening line (${how})`));
      }
    });

    const createHandle = (url: string): InspectorProcess => ({
      url,
      send(line: InspectorLine): void {
        if (hasExited || stopped || !child.stdin.writable) return;
        child.stdin.write(`${JSON.stringify(line)}\n`);
      },
      exited,
      stop(): Promise<void> {
        stopped = true;
        if (stopPromise === undefined) {
          stopPromise = (async () => {
            if (!hasExited) {
              child.stdin.end();
              const graceTimer = setTimeout(() => {
                if (!hasExited) child.kill('SIGKILL');
              }, graceMs);
              try {
                await exited;
              } finally {
                clearTimeout(graceTimer);
              }
            }
            rl.close();
          })();
        }
        return stopPromise;
      },
    });

    rl.on('line', (line) => {
      if (!settled) {
        const parsed = parseJson(line);
        if (isListeningLine(parsed)) {
          settled = true;
          started = true;
          clearTimeout(startTimer);
          resolve(createHandle(parsed.url));
        } else {
          failStart(
            new Error(`the inspector printed ${JSON.stringify(line)} before its listening line`),
          );
        }
        return;
      }

      if (!started) return;

      const parsed = parseJson(line);
      if (isRenderReportMessage(parsed)) {
        options.onRenderReport(parsed);
      } else {
        options.log(
          `cpg: warning: the inspector printed a line that is not a render-report: ${line}`,
        );
      }
    });
  });
}
