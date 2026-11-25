// REAL (U3.1.1 part 4, BMO-52): the extension's flows (controller decision 38), in plain node. Owns the host,
// the verify scheduler and the panel; extension.ts gives it VS Code.

import type { CpgEngine, EngineConfig, IndexReport } from '@cpg/engine';
import { parseWebviewMessage } from '@cpg/inspector';
import type { GraphPayload, ThemeSnapshot, VerificationReport } from '@cpg/model';
import type { FilesystemProbe, SourceOpener } from './contract';
import { serializeError } from './errors';
import { PanelGraphHost } from './graph-host';
import { GraphPanel, type PanelSurface } from './graph-panel';
import { revealMessage } from './reveal-message';
import { VerifyScheduler, type VerifySchedulerOptions } from './verify-scheduler';
import { loadWorkspaceConfig, type WorkspaceConfig } from './workspace-config';
import { workspaceProbe, type WorkspaceFileSystem } from './workspace-probe';

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
 * One workspace's graph in the editor. Whatever fails, the extension stays usable.
 *
 * An index loads the configuration, builds a NEW engine (its memory store merges, so an old one would
 * keep the nodes of deleted files), connects, indexes, and delivers engine.inspect's payload as an
 * `initial` snapshot (decision 28). Verify then judges it on the files admitted by the scope it was
 * indexed with. One message says what happened:
 * - a warning `CPG: <warnings joined by '; '>` when there are any: the configuration's, then the
 *   IndexReport's;
 * - an error `CPG: open a folder first` with no workspace folder;
 * - an error `CPG: cannot read the configuration: <message>`, `CPG: cannot open the graph store:
 *   <message>` or `CPG: the index failed: <message>`. The graph already held stays, and so does
 *   what verify judges it by;
 * - an error `CPG: verify failed: <message>` for what a verify run, or onReport, threw.
 *
 * A session that was opened is closed, however the index ended. Nothing asks for a verify run before
 * the first graph. An index and a verify never reject.
 */
export class GraphSession {
  private readonly options: GraphSessionOptions;
  private readonly host: PanelGraphHost;
  private readonly panel: GraphPanel;
  private readonly deactivation = new AbortController();
  /** From the first graph on. */
  private judge: Judge | undefined;
  private indexing: Promise<void> | undefined;

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
   * `cpg.openGraph`: shows the panel and indexes, which is the only refresh before U4. With no folder it
   * only says so. Resolves when both are done.
   */
  async openGraph(): Promise<void> {
    const shown = this.options.root === undefined ? undefined : this.panel.show();
    await Promise.all([shown, this.index()]);
  }

  /**
   * A panel VS Code restored after a reload: shown (GraphPanel.restore), and indexed as openGraph does.
   * Resolves when the panel has its HTML; the index goes on.
   */
  async restorePanel(surface: PanelSurface): Promise<void> {
    await this.panel.restore(surface);
    void this.index();
  }

  /**
   * `cpg.verify`: judges the graph held now, without indexing. With no graph yet it indexes first, opens
   * no panel, and judges that graph; when that index brings none, nothing is judged. Resolves with the
   * finished run's report (VerifyScheduler.now), or undefined when there is nothing to judge, the run threw,
   * or the extension was deactivated (controller decision 40).
   */
  async verify(): Promise<VerificationReport | undefined> {
    if (this.judge === undefined) await this.index();
    return this.judge?.scheduler.now();
  }

  /** The editor's theme changed. */
  setTheme(theme: ThemeSnapshot): void {
    this.host.setTheme(theme);
  }

  /**
   * Deactivation: aborts an index and cancels the pending verify. What was running delivers nothing and
   * says nothing. The panel is left open, so VS Code can restore it after a reload.
   */
  dispose(): void {
    this.deactivation.abort();
    this.judge?.scheduler.dispose();
    this.host.dispose();
  }

  private index(): Promise<void> {
    this.indexing ??= this.runIndex().finally(() => {
      this.indexing = undefined;
    });
    return this.indexing;
  }

  private async runIndex(): Promise<void> {
    const { root } = this.options;
    const { signal } = this.deactivation;
    if (signal.aborted) return;
    if (root === undefined) {
      this.options.showError('CPG: open a folder first');
      return;
    }
    let failed = 'cannot read the configuration';
    try {
      const workspace = await loadWorkspaceConfig(root);
      failed = 'cannot open the graph store';
      const { config } = workspace;
      const engine = this.options.createEngine({
        version: this.options.version,
        consumers: config.consumers,
      });
      const { host, port, graph } = config.store;
      const session = await engine.connect({ host, port, graph }, { readOnly: false });
      failed = 'the index failed';
      let report: IndexReport;
      let payload: GraphPayload;
      try {
        report = await engine.index({ config, session, resumeFrom: null }, () => undefined, signal);
        payload = await engine.inspect(session, config);
      } finally {
        await session.close();
      }
      if (!signal.aborted) await this.deliver(payload, workspace, report);
    } catch (thrown) {
      if (!signal.aborted) {
        this.options.showError(`CPG: ${failed}: ${serializeError(thrown).message}`);
      }
    }
  }

  private async deliver(
    payload: GraphPayload,
    workspace: WorkspaceConfig,
    report: IndexReport,
  ): Promise<void> {
    const probe = workspaceProbe(this.options.fileSystem, workspace.config);
    if (this.judge === undefined) this.judge = this.newJudge(probe);
    else this.judge.probe = probe;
    await this.host.onSnapshot(payload, { seq: payload.seq, cause: 'initial' });
    const warnings = [...workspace.warnings, ...report.warnings];
    if (warnings.length > 0) this.options.showWarning(`CPG: ${warnings.join('; ')}`);
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
