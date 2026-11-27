// `cpg watch`'s event stream (U4.2.1 part b, BMO-60; controller decisions 65-67): every WatchEvent
// on stdout as it arrives, the human lines on stderr, and with the inspector on, a full graph per
// refresh. run() turns the WatchEnd into an exit code (decision 66).

import type { CpgEngine, VerifyConfig, WatchEvent, WatchFailure, WatchRequest } from '@cpg/engine';
import type { InspectorProcess, StartInspector } from './inspector-process';
import type { Io } from './io';
import { livePicture } from './live';

/** How a watch ended, for run() to turn into an exit code. */
export type WatchEnd =
  | { readonly kind: 'signal' }
  | { readonly kind: 'eof' }
  | { readonly kind: 'error'; readonly error: WatchFailure }
  | { readonly kind: 'inspector'; readonly message: string };

export interface WatchStreamOptions {
  readonly engine: CpgEngine;
  /** The watch's request: its config and its one write session, which every refresh reads too. */
  readonly request: WatchRequest;
  readonly io: Io;
  /** `--quiet`: no batch lines on stderr. */
  readonly quiet: boolean;
  /** The run's signal (Ctrl-C). */
  readonly signal?: AbortSignal;
  /** Set when consumers.inspect is on: the launcher, and the config each refresh reads with. */
  readonly inspector?: { readonly start: StartInspector; readonly config: VerifyConfig };
}

interface WatchState {
  consumers: string;
  lastError: WatchFailure | undefined;
  closedReason: 'signal' | 'error' | 'eof' | undefined;
  inspectorFailure: string | undefined;
  watchResolved: boolean;
  proc: InspectorProcess | undefined;
  pending: number | undefined;
  pumping: boolean;
  pumpPromise: Promise<void> | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectorExitMessage(code: number | null, signal: string | null): string {
  const how = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
  return `the inspector exited unexpectedly (${how})`;
}

/**
 * Runs `engine.watch(request, onEvent, signal)` and resolves with how it ended, once it has resolved
 * and the inspector, if one started, has stopped. The caller closes the session.
 *
 * Stdout (decision 65, C-CLI I-8, I-23): each WatchEvent is `JSON.stringify(event)` on one line,
 * written inside `onEvent` before it returns; nothing else is written to stdout.
 *
 * Stderr (decision 65, I-10, P-A):
 * - `ready`: each of `report.warnings` as `cpg: warning: <w>`, then
 *   `cpg: watching <root>: indexed <report.walk.filesIndexed> files in <ms> ms; consumers: <list>`,
 *   `<ms>` being `Math.round(report.durationMs)`;
 * - `warning`: `cpg: warning: <message>`;
 * - `batch`, unless `quiet`: `cpg: batch <seq>: <changes.length> change(s) in <ms> ms; consumers:
 *   <list>`, `<ms>` being `Math.round(latencyMs.total)`.
 * `<list>` is the ready report's `consumers` joined by `, `, or `none` when it is empty. Every number
 * comes from the events: the CLI reads no clock (I-30).
 *
 * The end: `closed { reason: 'signal' }` is `signal`; `closed { reason: 'error' }` is `error` with
 * the latest `error` event's error; `closed { reason: 'eof' }` is `eof` (never produced in v1: there
 * is no stdin mode). `closed { reason: 'error' }` with no `error` event before it, or a watch that
 * resolves with no `closed`, is `error` with an `engine-rejected` failure.
 *
 * With `inspector` (decision 67): after `ready`, the inspector starts once and
 * `cpg: inspector at <url> (open it in a browser; Ctrl-C stops it)` is printed. `ready` (seq 0) and
 * each `batch` (its seq) trigger a refresh: `engine.verify(session, config, null)` and
 * `engine.inspect(session, config)` on the request's session, then a `graph` whose payload has `seq`
 * set to the trigger's seq, and a `verification`. Refreshes are latest-wins: one in flight, at most
 * one queued; a newer trigger replaces the queued one, and a refresh takes its seq when it starts
 * reading. A refresh that throws prints `cpg: warning: inspector refresh at seq <n> failed:
 * <message>` and the watch goes on. Render-reconciliation is judged against the payload last sent;
 * the verification sent with a graph uses the latest render-report received so far (`stale` for an
 * older graph, `unavailable` before any), and a render-report that changes the check re-sends the
 * verification (serveLive's rule).
 *
 * The inspector ending: an exit by SIGINT aborts the watch (the same Ctrl-C), and the end is the
 * watch's. Any other exit, or a start that rejects, aborts the watch, and the end is `inspector`
 * (`the inspector exited unexpectedly (code <n>)` or `(signal <s>)`, `cannot start the inspector:
 * <message>`), unless the watch's signal had already aborted or the watch closed on an error.
 *
 * Teardown: once the watch resolves, a queued refresh is dropped and the one in flight is awaited,
 * then the inspector is stopped.
 */
export async function streamWatch(options: WatchStreamOptions): Promise<WatchEnd> {
  // REAL
  const { engine, request, io, quiet, inspector } = options;
  const stopper = new AbortController();
  const onSignalAbort = (): void => {
    stopper.abort();
  };
  if (options.signal?.aborted === true) {
    stopper.abort();
  } else {
    options.signal?.addEventListener('abort', onSignalAbort, { once: true });
  }

  const picture = inspector !== undefined ? livePicture(io) : undefined;
  const state: WatchState = {
    consumers: 'none',
    lastError: undefined,
    closedReason: undefined,
    inspectorFailure: undefined,
    watchResolved: false,
    proc: undefined,
    pending: undefined,
    pumping: false,
    pumpPromise: undefined,
  };

  const failInspector = (message: string): void => {
    if (stopper.signal.aborted || state.watchResolved) return;
    state.inspectorFailure = message;
    stopper.abort();
  };

  const runPump = async (): Promise<void> => {
    if (inspector === undefined || picture === undefined) return;
    try {
      if (state.proc === undefined) {
        let started: InspectorProcess;
        try {
          started = await inspector.start({ onRenderReport: picture.onRenderReport });
        } catch (error: unknown) {
          failInspector(`cannot start the inspector: ${errorMessage(error)}`);
          return;
        }
        state.proc = started;
        if (state.watchResolved || stopper.signal.aborted) return;
        io.err(`cpg: inspector at ${started.url} (open it in a browser; Ctrl-C stops it)`);
        void started.exited.then(({ code, signal }) => {
          if (state.watchResolved) return;
          if (signal === 'SIGINT') {
            stopper.abort();
            return;
          }
          failInspector(inspectorExitMessage(code, signal));
        });
      }
      const active = state.proc;
      while (!state.watchResolved && !stopper.signal.aborted && state.pending !== undefined) {
        const seq = state.pending;
        state.pending = undefined;
        try {
          // oxlint-disable-next-line no-await-in-loop
          const verified = await engine.verify(request.session, inspector.config, null);
          // oxlint-disable-next-line no-await-in-loop
          const payload = await engine.inspect(request.session, inspector.config);
          picture.show(active, { ...payload, seq }, verified.checks);
        } catch (error: unknown) {
          io.err(
            `cpg: warning: inspector refresh at seq ${String(seq)} failed: ${errorMessage(error)}`,
          );
        }
      }
    } finally {
      state.pumping = false;
    }
  };

  const trigger = (seq: number): void => {
    if (inspector === undefined || stopper.signal.aborted || state.watchResolved) return;
    state.pending = seq;
    if (!state.pumping) {
      state.pumping = true;
      state.pumpPromise = runPump();
    }
  };

  const onEvent = (event: WatchEvent): void => {
    io.out(JSON.stringify(event));
    switch (event.kind) {
      case 'ready': {
        for (const w of event.report.warnings) {
          io.err(`cpg: warning: ${w}`);
        }
        state.consumers = event.report.consumers.join(', ') || 'none';
        io.err(
          `cpg: watching ${event.root}: indexed ${String(event.report.walk.filesIndexed)} files in ${String(Math.round(event.report.durationMs))} ms; consumers: ${state.consumers}`,
        );
        trigger(event.seq);
        break;
      }
      case 'batch': {
        if (!quiet) {
          io.err(
            `cpg: batch ${String(event.seq)}: ${String(event.changes.length)} change(s) in ${String(Math.round(event.latencyMs.total))} ms; consumers: ${state.consumers}`,
          );
        }
        trigger(event.seq);
        break;
      }
      case 'warning': {
        io.err(`cpg: warning: ${event.message}`);
        break;
      }
      case 'error': {
        state.lastError = event.error;
        break;
      }
      case 'closed': {
        state.closedReason = event.reason;
        break;
      }
    }
  };

  try {
    await engine.watch(request, onEvent, stopper.signal);
  } finally {
    state.watchResolved = true;
    state.pending = undefined;
    options.signal?.removeEventListener('abort', onSignalAbort);
    if (state.pumpPromise !== undefined) {
      await state.pumpPromise;
    }
    picture?.close();
    if (state.proc !== undefined) {
      await state.proc.stop();
    }
  }

  if (state.closedReason === 'error') {
    return {
      kind: 'error',
      error: state.lastError ?? {
        kind: 'engine-rejected',
        message: 'the watch closed on an error it did not report',
      },
    };
  }
  if (state.closedReason === undefined) {
    return {
      kind: 'error',
      error: {
        kind: 'engine-rejected',
        message: 'the watch ended without a closed event',
      },
    };
  }
  if (state.inspectorFailure !== undefined) {
    return { kind: 'inspector', message: state.inspectorFailure };
  }
  if (state.closedReason === 'eof') {
    return { kind: 'eof' };
  }
  return { kind: 'signal' };
}
