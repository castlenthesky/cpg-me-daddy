// `cpg watch`'s event stream (U4.2.1 part b, BMO-60; controller decisions 65-67): every WatchEvent
// on stdout as it arrives, the human lines on stderr, and with the inspector on, a full graph per
// refresh. run() turns the WatchEnd into an exit code (decision 66).

import type { CpgEngine, VerifyConfig, WatchFailure, WatchRequest } from '@cpg/engine';
import type { StartInspector } from './inspector-process';
import type { Io } from './io';

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
export function streamWatch(_options: WatchStreamOptions): Promise<WatchEnd> {
  // SEAT: U4.2.1 part b (decisions 65-67)
  return Promise.reject(new Error('SEAT: streamWatch is not built yet (U4.2.1 part b)'));
}
