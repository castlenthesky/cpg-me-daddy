// REAL (U3.1.1 part 2, BMO-52): when verify runs (C-EXT OQ-5; controller decision 36). No clock of its
// own: the extension passes setTimeout, the tests a fake.

import type { VerificationReport } from '@cpg/model';

/** BMO-52: "debounced 500 ms after the last delta". */
const VERIFY_DEBOUNCE_MS = 500;

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
 *   that is later;
 * - `dispose` cancels the timer. After it nothing starts, and a run still going reports nothing. The
 *   host's own dispose is what keeps that run from posting to the page.
 */
export class VerifyScheduler {
  private readonly options: VerifySchedulerOptions;
  private cancelTimer: () => void = () => undefined;
  private running = false;
  /** What asked for the one run to start when the run going ends. */
  private owedTo: 'changed' | 'now' | undefined;
  private disposed = false;

  constructor(options: VerifySchedulerOptions) {
    this.options = options;
  }

  changed(): void {
    // A run owed to `now` judges this change too, and does not wait for it.
    if (this.disposed || this.owedTo === 'now') return;
    this.owedTo = undefined;
    this.cancelTimer();
    this.cancelTimer = this.options.after(VERIFY_DEBOUNCE_MS, () => this.request('changed'));
  }

  now(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.request('now');
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private request(by: 'changed' | 'now'): void {
    if (this.running) this.owedTo = by;
    else void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    this.owedTo = undefined;
    try {
      const report = await this.options.verify();
      if (!this.disposed) this.options.onReport(report);
    } catch (thrown) {
      if (!this.disposed) this.options.onError(thrown);
    } finally {
      this.running = false;
      if (this.owedTo !== undefined && !this.disposed) void this.run();
    }
  }
}
