// REAL (U3.1.1 part 4, BMO-52): the extension's flows (controller decision 38), in plain node. Owns the host,
// the verify scheduler and the panel; extension.ts gives it VS Code. U4.2.2 (BMO-132): one watch keeps the
// graph current (controller decisions 70 to 74). SEAT: the watch driver (`watch`).

import type { CpgEngine, EngineConfig } from '@cpg/engine';
import { parseWebviewMessage } from '@cpg/inspector';
import type { ThemeSnapshot, VerificationReport } from '@cpg/model';
import type { FilesystemProbe, SourceOpener } from './contract';
import { serializeError } from './errors';
import { PanelGraphHost } from './graph-host';
import { GraphPanel, type PanelSurface } from './graph-panel';
import { revealMessage } from './reveal-message';
import { VerifyScheduler, type VerifySchedulerOptions } from './verify-scheduler';
import type { WorkspaceFileSystem } from './workspace-probe';

export interface GraphSessionOptions {
  /** The first workspace folder's absolute path; undefined: there is none (decision 35). */
  readonly root: string | undefined;
  /** EngineConfig.version: the extension's manifest version (C-CLI I-13). */
  readonly version: string;
  readonly createEngine: (config: EngineConfig) => CpgEngine;
  /** The workspace at `root`. */
  readonly fileSystem: WorkspaceFileSystem;
  readonly opener: SourceOpener;
  readonly theme: ThemeSnapshot;
  /** Makes a panel. */
  readonly createPanel: () => PanelSurface;
  /** Where the page bundle is. */
  readonly pageDirectory: string;
  /** The verify scheduler's clock. */
  readonly after: VerifySchedulerOptions['after'];
  /** Each finished verify run's report, for the status bar and the diagnostics. */
  readonly onReport: (report: VerificationReport) => void;
  readonly showWarning: (text: string) => void;
  readonly showError: (text: string) => void;
}

interface Judge {
  readonly scheduler: VerifyScheduler;
  /** On the scope the graph held was indexed with. */
  probe: FilesystemProbe;
}

/**
 * One workspace's graph in the editor, kept current by ONE watch (U4.2.2, BMO-132; controller decisions
 * 70 to 74). Whatever fails, the extension stays usable.
 *
 * A watch loads the configuration, builds a NEW engine, connects, and runs `engine.watch({ config: {
 * ...config, trailingMs, ceilingMs }, session }, onEvent, signal)`, the debounce window being the
 * configuration's `watch.trailingMs` and `watch.ceilingMs`. Its session is closed once `watch()` has
 * resolved and its refresh has settled. VS Code's own file events are not used (VD-33, P-A).
 * - `ready` and each `batch` ask for a refresh at the event's seq: `engine.inspect` on the watch's
 *   session, then `host.onSnapshot({ ...payload, seq }, { seq, cause })`. Refreshes are latest-wins:
 *   one in flight, at most one queued, and a newer request replaces the queued one. There are no
 *   graph deltas (decision 67's reasons).
 * - The first snapshot a watch delivers is `initial` (a new epoch, C-EXT I-13); verify then judges by
 *   that watch's scope, and the warnings follow it. Every later one is `catch-up`: the epoch is kept and
 *   the seq grows (I-12). When ready's refresh succeeds, as it normally does, ready is the initial one.
 * - Generations (decision 71, BMO-121): starting a watch aborts the one before and waits for its end
 *   (watch() resolved, its queued refresh dropped, the one in flight settled, its session closed)
 *   before it loads anything. A refresh delivers only while its watch is the latest and the session is
 *   not disposed, so nothing a replaced engine was still delivering lands in the new graph.
 * - A watch is live from its start until its `closed` (or the end of a start that failed). While one is
 *   live, `cpg.openGraph` and a restored panel start nothing (decision 72, BMO-109).
 *
 * One message says what happened:
 * - a warning `CPG: <warnings joined by '; '>` after the first snapshot, when there are any: the
 *   configuration's, then ready's IndexReport's;
 * - a warning `CPG: <message>` for each `warning` event;
 * - an error `CPG: open a folder first` with no workspace folder;
 * - an error `CPG: cannot read the configuration: <message>` or `CPG: cannot open the graph store:
 *   <message>` when the watch cannot start; `CPG: the watch stopped: <message>` for an `error` event
 *   (or a watch() that rejects); `CPG: the graph refresh failed: <message>` for a refresh that throws
 *   (the watch goes on); `CPG: cannot close the graph store: <message>`. The graph already held
 *   stays, and so does what verify judges it by;
 * - an error `CPG: verify failed: <message>` for what a verify run, or onReport, threw.
 * Nothing is said after dispose. Nothing asks for a verify run before the first graph. A verify run
 * whose graph moved while it ran is shown nowhere (decision 73). No public method rejects.
 */
export class GraphSession {
  private readonly options: GraphSessionOptions;
  private readonly host: PanelGraphHost;
  private readonly panel: GraphPanel;
  private disposed = false;
  /** From the first graph on. */
  private judge: Judge | undefined;

  constructor(options: GraphSessionOptions) {
    this.options = options;
    this.host = new PanelGraphHost({
      theme: options.theme,
      parse: parseWebviewMessage,
      opener: options.opener,
      onReveal: (outcome) => {
        const message = revealMessage(outcome);
        if (message !== undefined) this.options.showWarning(message);
      },
      onChange: () => this.judge?.scheduler.changed(),
    });
    this.panel = new GraphPanel({
      host: this.host,
      create: options.createPanel,
      directory: options.pageDirectory,
    });
  }

  /**
   * `cpg.openGraph`: shows the panel and starts a watch when none is live. With no folder it only says so.
   * Resolves when the panel is shown and the watch has delivered its first graph (or ended).
   */
  async openGraph(): Promise<void> {
    const shown = this.options.root === undefined ? undefined : this.panel.show();
    await Promise.all([shown, this.watch()]);
  }

  /**
   * A panel VS Code restored after a reload: shown (GraphPanel.restore), and a watch started as openGraph
   * does. Resolves when the panel has its HTML; the watch goes on.
   */
  async restorePanel(surface: PanelSurface): Promise<void> {
    await this.panel.restore(surface);
    void this.watch();
  }

  /**
   * `cpg.verify`: judges the graph held now. With no graph yet it starts a watch when none is live, opens
   * no panel, waits for the watch's first graph (or its end), and judges that; when there is still none,
   * nothing is judged. Resolves with the report of the run it caused or, when that run's graph moved
   * while it ran, of the next run (VerifyScheduler.now), or undefined when there is nothing to judge, the
   * run threw, or the extension was deactivated (controller decisions 40, 72, 73).
   */
  async verify(): Promise<VerificationReport | undefined> {
    if (this.judge === undefined) await this.watch();
    return this.judge?.scheduler.now();
  }

  /** The editor's theme changed. */
  setTheme(theme: ThemeSnapshot): void {
    this.host.setTheme(theme);
  }

  /**
   * Deactivation: aborts the watch (it closes itself, then its session) and cancels the pending verify.
   * Synchronous. What was running delivers nothing and says nothing. The panel is left open, so VS Code
   * can restore it after a reload.
   */
  dispose(): void {
    this.disposed = true;
    this.judge?.scheduler.dispose();
    this.host.dispose();
  }

  /**
   * The live watch's first graph, or a new watch's (decision 72): resolves when it has delivered its
   * first graph or ended. SEAT (U4.2.2): the watch driver is not built yet.
   */
  private watch(): Promise<void> {
    return Promise.reject(new Error('SEAT: U4.2.2: the watch driver is not built yet'));
  }

  private newJudge(probe: FilesystemProbe): Judge {
    const judge: Judge = {
      probe,
      scheduler: new VerifyScheduler({
        verify: () => this.host.verify(judge.probe),
        onReport: this.options.onReport,
        onError: (thrown) =>
          this.options.showError(`CPG: verify failed: ${serializeError(thrown).message}`),
        after: this.options.after,
      }),
    };
    return judge;
  }
}
