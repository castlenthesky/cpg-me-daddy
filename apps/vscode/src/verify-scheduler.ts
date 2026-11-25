// SEAT (U3.1.1 part 2, BMO-52): when verify runs (C-EXT OQ-5; controller decision 36). No clock of its
// own: the extension passes setTimeout, the tests a fake.

import type { VerificationReport } from '@cpg/model';

/** BMO-52: "debounced 500 ms after the last delta". */
export const VERIFY_DEBOUNCE_MS = 500;

export interface VerifySchedulerOptions {
  /** One run: `() => host.verify(probe)`. */
  readonly verify: () => Promise<VerificationReport>;
  /** Each finished run's report, for the status bar and the diagnostics (the host posts the banner). */
  readonly onReport: (report: VerificationReport) => void;
  /** What a run, or `onReport`, threw. Later runs still happen. */
  readonly onError: (thrown: unknown) => void;
  /** Calls `callback` once after `ms`; the function it returns cancels that. */
  readonly after: (ms: number, callback: () => void) => () => void;
}

/**
 * Runs verify one at a time:
 * - `changed` (the host's onChange) asks for a run VERIFY_DEBOUNCE_MS after the last `changed`;
 * - `now` (the `cpg.verify` command) runs at once and cancels the pending timer;
 * - requests during a run lead to exactly one more: at the end of the run when `now` was called
 *   during it; otherwise VERIFY_DEBOUNCE_MS after the last `changed`, or at the end of the run when
 *   that is later. Starting a run cancels the pending timer, because the run judges what is there
 *   when it starts;
 * - `dispose` cancels the timer. After it nothing starts, and a run still going reports nothing. The
 *   host's own dispose is what keeps that run from posting to the page.
 */
export class VerifyScheduler {
  protected readonly options: VerifySchedulerOptions;

  constructor(options: VerifySchedulerOptions) {
    this.options = options;
  }

  changed(): void {
    throw new Error('SEAT: VerifyScheduler.changed lands with U3.1.1 part 2');
  }

  now(): void {
    throw new Error('SEAT: VerifyScheduler.now lands with U3.1.1 part 2');
  }

  dispose(): void {
    throw new Error('SEAT: VerifyScheduler.dispose lands with U3.1.1 part 2');
  }
}
