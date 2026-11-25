// SEAT (U3.1.1 part 4, BMO-52): the extension's flows (controller decision 38), in plain node. Owns the host,
// the verify scheduler and the panel; extension.ts gives it VS Code.

import type { CpgEngine, EngineConfig } from '@cpg/engine';
import type { ThemeSnapshot, VerificationReport } from '@cpg/model';
import type { SourceOpener } from './contract';
import type { PanelSurface } from './graph-panel';
import type { VerifySchedulerOptions } from './verify-scheduler';
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

/**
 * One workspace's graph in the editor. Every method leaves the extension usable whatever fails, and
 * none rejects.
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
 * the first graph.
 */
export class GraphSession {
  private readonly options: GraphSessionOptions;

  constructor(options: GraphSessionOptions) {
    this.options = options;
  }

  /**
   * `cpg.openGraph`: shows the panel and indexes, which is the only refresh before U4. With no folder it
   * only says so. Resolves when both are done.
   */
  openGraph(): Promise<void> {
    throw new Error('SEAT: GraphSession.openGraph (U3.1.1 part 4)');
  }

  /**
   * A panel VS Code restored after a reload: shown (GraphPanel.restore), and indexed as openGraph does.
   * Resolves when the panel has its HTML; the index goes on.
   */
  restorePanel(_surface: PanelSurface): Promise<void> {
    throw new Error('SEAT: GraphSession.restorePanel (U3.1.1 part 4)');
  }

  /**
   * `cpg.verify`: judges the graph held now, without indexing. With no graph yet it indexes first, opens
   * no panel, and judges that graph; when that index brings none, nothing is judged. Resolves when
   * the run has been asked for.
   */
  verify(): Promise<void> {
    throw new Error('SEAT: GraphSession.verify (U3.1.1 part 4)');
  }

  /** The editor's theme changed. */
  setTheme(_theme: ThemeSnapshot): void {
    throw new Error('SEAT: GraphSession.setTheme (U3.1.1 part 4)');
  }

  /**
   * Deactivation: aborts an index and cancels the pending verify. What was running delivers nothing and
   * says nothing. The panel is left open, so VS Code can restore it after a reload.
   */
  dispose(): void {
    throw new Error('SEAT: GraphSession.dispose (U3.1.1 part 4)');
  }
}
