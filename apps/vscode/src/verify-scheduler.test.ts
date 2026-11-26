// When verify runs (C-EXT OQ-5, controller decision 36). The clock is a fake: nothing here waits.

import type { GraphPayload, HostToWebview, VerificationReport, WebviewToHost } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type { WebviewTransport } from './contract';
import { PanelGraphHost } from './graph-host';
import { VerifyScheduler, type VerifySchedulerOptions } from './verify-scheduler';

class FakeClock {
  time = 0;
  private readonly timers = new Map<symbol, { at: number; callback: () => void }>();

  readonly after = (ms: number, callback: () => void): (() => void) => {
    const key = Symbol('timer');
    this.timers.set(key, { at: this.time + ms, callback });
    return () => {
      this.timers.delete(key);
    };
  };
  get pending(): number {
    return this.timers.size;
  }
  /** Moves time on, firing what falls due in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end);
      const [next] = due.toSorted(([, a], [, b]) => a.at - b.at);
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = end;
  }
}

const noop = () => undefined;
const allMicrotasks = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** A scheduler whose runs end when the test says so; the run started n-th (from 1) reports seq n. */
function setUp(over: Partial<VerifySchedulerOptions> = {}) {
  const clock = new FakeClock();
  const starts: number[] = [];
  const reports: number[] = [];
  const errors: unknown[] = [];
  const going: { readonly seq: number; settle: (error?: Error) => void }[] = [];
  let overlaps = 0;
  const scheduler = new VerifyScheduler({
    verify: () =>
      new Promise<VerificationReport>((resolve, reject) => {
        starts.push(clock.time);
        if (going.length > 0) overlaps += 1;
        const seq = starts.length;
        const settle = (error?: Error) => {
          if (error !== undefined) reject(error);
          else resolve({ epoch: 1, seq, checks: [], state: 'pass' });
        };
        going.push({ seq, settle });
      }),
    onReport: (made) => reports.push(made.seq),
    onError: (thrown) => errors.push(thrown),
    after: clock.after,
    ...over,
  });
  /** Ends the run that is going, with `error` when given. */
  const end = async (error?: Error) => {
    const run = going.shift();
    if (run === undefined) throw new Error('no run is going');
    run.settle(error);
    await allMicrotasks();
  };
  return { clock, scheduler, starts, reports, errors, end, going, overlaps: () => overlaps };
}

type Step = 'changed' | 'now' | 'end' | number;

// Each script starts at time 0; a number moves time on; `end` ends the run that is going. Afterwards
// time moves on and every run is ended, so a run that should not happen shows up as one start too many.
describe('when a run starts', () => {
  it.each<[string, Step[], number[]]>([
    ['a change: 500 ms after it, once', ['changed', 499, 1, 'end'], [500]],
    ['a burst: 500 ms after its last change', ['changed', 300, 'changed', 499, 'changed'], [1299]],
    ['a change after a run: another', ['changed', 500, 'end', 'changed'], [500, 1000]],
    ['now: at once, in place of the pending one', ['changed', 499, 'now', 'end'], [499]],
    ['now while idle, twice: two', ['now', 'end', 100, 'now'], [0, 100]],
    ['several now in a run: one more, when it ends', ['now', 'now', 'now', 70, 'end'], [0, 70]],
    ['a change in a run that ends first', ['now', 'changed', 200, 'end'], [0, 500]],
    ['changes in a run that outlasts them', ['now', 'changed', 'changed', 5000, 'end'], [0, 5000]],
    [
      'a later change in such a run: 500 ms after that one',
      ['now', 'changed', 600, 'changed', 100, 'end'],
      [0, 1100],
    ],
    ['a change, then now, in a run', ['now', 'changed', 'now', 70, 'end'], [0, 70]],
    ['now, then a change, in a run', ['now', 'now', 'changed', 70, 'end'], [0, 70]],
    ['a change overdue, then now, in a run', ['now', 'changed', 600, 'now', 'end'], [0, 600]],
    ['now, then a change overdue, in a run', ['now', 'now', 'changed', 600, 'end'], [0, 600]],
    ['a change in the one more: another', ['now', 'now', 'end', 'changed', 'end'], [0, 0, 500]],
  ])('%s', async (_what, script, expected) => {
    const { clock, scheduler, starts, reports, end, going, overlaps } = setUp();
    /* oxlint-disable no-await-in-loop -- one step at a time */
    for (const step of script) {
      if (typeof step === 'number') clock.advance(step);
      else if (step === 'end') await end();
      else scheduler[step]();
    }
    for (let i = 0; i < 4; i += 1) {
      clock.advance(10_000);
      if (going.length > 0) await end();
    }
    /* oxlint-enable no-await-in-loop */
    expect(starts).toEqual(expected);
    expect(reports).toEqual(expected.map((_at, index) => index + 1));
    expect(overlaps()).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

describe('a run that fails', () => {
  it('goes to onError; the run owed and later ones still happen', async () => {
    const { scheduler, end, starts, reports, errors } = setUp();
    const broken = new Error('no probe');
    scheduler.now();
    scheduler.now();
    await end(broken);
    expect(errors).toEqual([broken]);
    expect(starts).toHaveLength(2);
    await end();
    scheduler.now();
    await end();
    expect(reports).toEqual([2, 3]);
    expect(errors).toHaveLength(1);
  });

  const broken = new Error('gone');
  const fail = () => {
    throw broken;
  };
  it.each([
    ['an onReport that throws', { onReport: fail }],
    ['a verify that throws before it returns', { verify: fail }],
  ])('so does %s', async (_what, over) => {
    const { scheduler, end, errors, going } = setUp(over);
    for (const expected of [1, 2]) {
      scheduler.now();
      if (going.length > 0) await end(); // oxlint-disable-line no-await-in-loop -- one run at a time
      await allMicrotasks(); // oxlint-disable-line no-await-in-loop -- one run at a time
      expect(errors).toEqual(Array.from({ length: expected }, () => broken));
    }
  });
});

// Round two (review a7).
it('an onReport that throws does not drop the run owed', async () => {
  const { scheduler, end, starts, errors } = setUp({
    onReport: () => {
      throw new Error('gone');
    },
  });
  scheduler.now();
  scheduler.now();
  await end();
  expect(errors).toHaveLength(1);
  expect(starts).toHaveLength(2);
});

describe('dispose', () => {
  it('cancels the timer, and nothing starts after it', () => {
    const { clock, scheduler, starts } = setUp();
    scheduler.changed();
    scheduler.dispose();
    expect(clock.pending).toBe(0);
    scheduler.changed();
    scheduler.now();
    scheduler.dispose();
    clock.advance(10_000);
    expect(starts).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  // Post-implementation: closes sabotage survivor "changed after dispose sets a timer".
  it('a change after it sets no timer', () => {
    const { clock, scheduler, starts } = setUp();
    scheduler.dispose();
    scheduler.changed();
    expect(clock.pending).toBe(0);
    clock.advance(10_000);
    expect(starts).toEqual([]);
  });

  it.each([undefined, new Error('late')])(
    'a run that ends after it (error: %s) reports nothing, and the one owed never starts',
    async (error) => {
      const { scheduler, end, starts, reports, errors } = setUp();
      scheduler.now();
      scheduler.now();
      scheduler.dispose();
      await end(error);
      expect(starts).toEqual([0]);
      expect([reports, errors]).toEqual([[], []]);
    },
  );
});

// The page here answers as apps/inspector/src/graph-app.ts does: a render-report per graph it draws and
// nothing for a verification (pinned there by "writes the latest verify report into the banner and
// posts nothing").
describe('with a host and a page (decision 36)', () => {
  class Page implements WebviewTransport {
    readonly cspSource = 'vscode-webview:';
    readonly heard: string[] = [];
    private handler: (message: unknown) => void = noop;

    post(message: HostToWebview): void {
      this.heard.push(message.type);
      if (message.type !== 'graph') return;
      const { epoch, seq } = message;
      const nodes = message.payload.nodes.length;
      const counts = { payloadNodeCount: nodes, renderedNodeCount: nodes, renderedEdgeCount: 0 };
      const drawn = { ...counts, duplicateEdges: 0, droppedNodeIds: [], frameMs: 1 };
      this.handler({ type: 'render-report', epoch, seq, report: drawn });
    }
    onMessage(handler: (message: unknown) => void) {
      this.handler = handler;
      return { dispose: noop };
    }
    ready(): void {
      this.handler({ type: 'ready', protocol: 1 });
    }
  }

  const P: GraphPayload = { seq: -1, nodes: [{ id: 'dir:.', type: 'DIRECTORY' }], edges: [] };

  function wired() {
    const clock = new FakeClock();
    const verified: (string | undefined)[] = [];
    const probe = { listFiles: async () => [], digest: async () => undefined };
    const scheduler = new VerifyScheduler({
      verify: () => host.verify(probe),
      onReport: ({ checks }) =>
        verified.push(checks.find((check) => check.id === 'render-reconciliation')?.state),
      onError: (thrown) => {
        throw thrown;
      },
      after: clock.after,
    });
    const host = new PanelGraphHost({
      theme: { kind: 'dark', nodeColors: {}, defaultNodeColor: 'x' },
      parse: (message) => message as WebviewToHost, // oxlint-disable-line typescript/no-unsafe-type-assertion -- the fake page sends only WebviewToHost
      opener: { open: async () => undefined },
      onReveal: noop,
      onChange: () => scheduler.changed(),
    });
    const page = new Page();
    host.attach(page);
    const quiet = async (ms: number) => {
      clock.advance(ms);
      await allMicrotasks();
    };
    return { host, page, verified, quiet, clock };
  }

  it('a drawn graph is verified once, with its render-report, and that does not loop', async () => {
    const { host, page, verified, quiet, clock } = wired();
    page.ready();
    await host.onSnapshot(P, { seq: -1, cause: 'initial' });
    for (let i = 0; i < 20; i += 1) await quiet(500); // oxlint-disable-line no-await-in-loop -- one step at a time
    expect(verified).toEqual(['pass']);
    expect(page.heard).toEqual(['theme', 'graph', 'verification']);
    expect(clock.pending).toBe(0);
  });

  it('a page that draws late is verified again: without its report it was unavailable', async () => {
    const { host, page, verified, quiet } = wired();
    await host.onSnapshot(P, { seq: -1, cause: 'initial' });
    await quiet(500);
    page.ready();
    await quiet(499);
    expect(verified).toEqual(['unavailable']);
    await quiet(1);
    expect(verified).toEqual(['unavailable', 'pass']);
    expect(page.heard).toEqual(['theme', 'graph', 'verification']);
  });
});
