// REAL (U3.1.1 part 2, BMO-52; U3.1.2, BMO-56; U4.2.2, BMO-132): when verify runs (C-EXT OQ-5; controller
// decisions 36, 40 and 73). No clock of its own: the extension passes setTimeout, the tests a fake.

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
  /**
   * Whether a finished run's report still describes the graph held (controller decision 73): false when
   * the graph moved while it ran. Absent: every report is current.
   */
  readonly current?: (report: VerificationReport) => boolean;
}

/**
 * Runs verify one at a time:
 * - `changed` (the host's onChange) asks for a run VERIFY_DEBOUNCE_MS after the last `changed`;
 * - `now` (the `cpg.verify` command) runs at once and cancels the pending timer;
 * - requests during a run lead to exactly one more: at the end of the run when `now` was called
 *   during it; otherwise VERIFY_DEBOUNCE_MS after the last `changed`, or at the end of the run when
 *   that is later;
 * - a run whose report is not `current` reports nothing (no onReport), and the `now` requests it would
 *   have answered wait for the next run instead (decision 73). The change that moved the graph has
 *   already asked for that run;
 * - `dispose` cancels the timer. After it nothing starts, a run still going reports nothing, and every
 *   `now` still open resolves with undefined. The host's own dispose is what keeps that run from posting
 *   to the page.
 *
 * SEAT (U4.2.2): `current` is not read yet.
 */
export class VerifyScheduler {
  private readonly options: VerifySchedulerOptions;
  private cancelTimer: () => void = () => undefined;
  private running = false;
  /** What asked for the one run to start when the run going ends. */
  private owedTo: 'changed' | 'now' | undefined;
  /** The `now` requests the owed run answers. */
  private readonly waiting: ((report: VerificationReport | undefined) => void)[] = [];
  private disposed = false;

  constructor(options: VerifySchedulerOptions) {
    this.options = options;
  }

  changed(): void {
    // A run owed to `now` judges this change too, and does not wait for it.
    if (this.disposed || this.owedTo === 'now') return;
    this.owedTo = undefined;
    this.cancelTimer();
    this.cancelTimer = this.options.after(VERIFY_DEBOUNCE_MS, () => {
      if (this.running) this.owedTo = 'changed';
      else void this.run();
    });
  }

  /**
   * Asks for a run at once. Resolves, when that run ends, with its report: the run started here or, during
   * a run, the one run this leads to, which every request made in the meantime shares (controller decision
   * 40). undefined when there is no report: the run threw, or dispose came first. Never rejects.
   */
  now(): Promise<VerificationReport | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    this.cancelTimer();
    if (!this.running) return this.run();
    this.owedTo = 'now';
    return new Promise<VerificationReport | undefined>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    for (const resolve of this.waiting.splice(0)) resolve(undefined);
  }

  private async run(): Promise<VerificationReport | undefined> {
    this.running = true;
    this.owedTo = undefined;
    const waiters = this.waiting.splice(0);
    let report: VerificationReport | undefined;
    try {
      const finished = await this.options.verify();
      if (!this.disposed) {
        report = finished;
        this.options.onReport(finished);
      }
    } catch (thrown) {
      if (!this.disposed) this.options.onError(thrown);
    } finally {
      this.running = false;
      for (const resolve of waiters) resolve(report);
      if (this.owedTo !== undefined && !this.disposed) void this.run();
    }
    return report;
  }
}
