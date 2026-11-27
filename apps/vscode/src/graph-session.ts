// REAL (U3.1.1 part 4, BMO-52): the extension's flows (controller decision 38), in plain node. Owns the host,
// the verify scheduler and the panel; extension.ts gives it VS Code. U4.2.2 (BMO-132): one watch keeps the
// graph current (controller decisions 70 to 74).

import type { CpgEngine, EngineConfig, EngineSession, WatchEvent } from '@cpg/engine';
import { parseWebviewMessage } from '@cpg/inspector';
import type { GraphPayload, ThemeSnapshot, VerificationReport } from '@cpg/model';
import type { FilesystemProbe, SourceOpener } from './contract';
import { serializeError } from './errors';
import { PanelGraphHost } from './graph-host';
import { GraphPanel, type PanelSurface } from './graph-panel';
import { asError, elapsed, silentLogger, type Logger } from './log';
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
  /**
   * Where the session says what it is doing: the extension's "CPG" log channel. Every message shown to
   * the human is also logged, an error with its stack. Silent when absent.
   */
  readonly log?: Logger;
}

interface Judge {
  readonly scheduler: VerifyScheduler;
  /** On the scope the graph held was indexed with. */
  probe: FilesystemProbe;
}

/** What a started watch refreshes with: its configuration, its engine and its one session. */
interface WatchResources {
  readonly workspace: WorkspaceConfig;
  readonly engine: CpgEngine;
  readonly session: EngineSession;
}

/** One watch (decisions 70 and 71). */
interface Watch {
  /** Its refreshes deliver only while this is the session's latest (and it is not disposed). */
  readonly generation: number;
  /** Aborted by dispose, or when the next watch starts. */
  readonly stop: AbortController;
  /** From its start until its `closed`, or the end of a start that failed (decision 72). */
  live: boolean;
  /** A snapshot was delivered: the next one is a catch-up. */
  delivered: boolean;
  /** The seq of the one refresh queued (latest-wins). */
  pending: number | undefined;
  /** A refresh is in flight; `pump` settles when the last one has. */
  pumping: boolean;
  pump: Promise<void> | undefined;
  /** ready's IndexReport warnings, said after the first snapshot. */
  readyWarnings: readonly string[];
  /** Settles after the first refresh settles, or when the watch has ended. */
  firstGraph: Promise<void>;
  settleFirst: (() => void) | undefined;
  /** Listeners subscribed on this watch's rescan trigger (decision 79). */
  readonly rescanListeners: Set<() => void>;
  /** Settles when watch() has resolved, the refresh settled and the session closed. */
  ended: Promise<void>;
}

/**
 * One workspace's graph in the editor, kept current by ONE watch (U4.2.2, BMO-132; controller decisions
 * 70 to 74, 78, 79). Whatever fails, the extension stays usable.
 *
 * A watch loads the configuration, builds a NEW engine, connects, and runs `engine.watch({ config: {
 * ...config, trailingMs, ceilingMs, rescanIntervalMs }, session, rescan }, onEvent, signal)`, the
 * debounce window and rescan interval coming from the configuration's `watch.*`. Its session is
 * closed once `watch()` has resolved and its refresh has settled. VS Code's own file events are not
 * used (VD-33, P-A).
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
 * - a warning `CPG: no graph is being watched` when `cpg.rescan` runs with no live watch;
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
  private generation = 0;
  private current: Watch | undefined;
  private disposed = false;
  /** From the first graph on. */
  private judge: Judge | undefined;
  private readonly log: Logger;

  constructor(options: GraphSessionOptions) {
    this.options = options;
    this.log = options.log ?? silentLogger;
    this.host = new PanelGraphHost({
      theme: options.theme,
      parse: parseWebviewMessage,
      opener: options.opener,
      onReveal: (outcome) => {
        const message = revealMessage(outcome);
        if (message === undefined) {
          if (outcome.ok) this.log.debug(`opened ${outcome.filePath} (${outcome.target})`);
        } else {
          this.warn(message);
        }
      },
      onChange: () => this.judge?.scheduler.changed(),
      onFault: (fault) => this.log.warn(`protocol fault: ${fault.kind}`, fault),
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
    this.log.info('cpg.openGraph');
    const shown = this.options.root === undefined ? undefined : this.panel.show();
    await Promise.all([shown, this.watch()]);
  }

  /**
   * A panel VS Code restored after a reload: shown (GraphPanel.restore), and a watch started as openGraph
   * does. Resolves when the panel has its HTML; the watch goes on.
   */
  async restorePanel(surface: PanelSurface): Promise<void> {
    this.log.info('restoring the graph panel after a reload');
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
    this.log.info('cpg.verify');
    if (this.judge === undefined) await this.watch();
    return this.judge?.scheduler.now();
  }

  /**
   * `cpg.rescan` (controller decision 79): asks the live watch to crawl the workspace now, through
   * the trigger its request carries. With no live watch it only warns `CPG: no graph is being
   * watched`. Nothing after dispose.
   */
  rescan(): void {
    this.log.info('cpg.rescan');
    if (this.disposed) return;
    if (this.current?.live !== true) {
      this.warn('CPG: no graph is being watched');
      return;
    }
    for (const listener of Array.from(this.current.rescanListeners)) {
      listener();
    }
  }

  /** The editor's theme changed. */
  setTheme(theme: ThemeSnapshot): void {
    this.log.debug(`theme: ${theme.kind}`);
    this.host.setTheme(theme);
  }

  /**
   * Deactivation: aborts the watch (it closes itself, then its session) and cancels the pending verify.
   * Synchronous. What was running delivers nothing and says nothing. The panel is left open, so VS Code
   * can restore it after a reload.
   */
  dispose(): void {
    this.log.info('deactivated: the watch stops');
    this.disposed = true;
    this.current?.stop.abort();
    this.judge?.scheduler.dispose();
    this.host.dispose();
  }

  /** A warning for the human, logged first. */
  private warn(text: string): void {
    this.log.warn(text);
    this.options.showWarning(text);
  }

  /** An error for the human, logged first with the stack of what was thrown. */
  private fail(text: string, thrown?: unknown): void {
    if (thrown === undefined) this.log.error(text);
    else this.log.error(text, asError(thrown));
    this.options.showError(text);
  }

  private isCurrent(watch: Watch): boolean {
    return !this.disposed && watch.generation === this.generation;
  }

  /**
   * The live watch's first graph, or a new watch's (decision 72): resolves when it has delivered its
   * first graph or ended.
   */
  private watch(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const { root } = this.options;
    if (root === undefined) {
      this.fail('CPG: open a folder first');
      return Promise.resolve();
    }
    if (this.current?.live === true) {
      this.log.debug(`watch ${String(this.current.generation)} is live: nothing to start`);
      return this.current.firstGraph;
    }

    this.generation += 1;
    const watch: Watch = {
      generation: this.generation,
      stop: new AbortController(),
      live: true,
      delivered: false,
      pending: undefined,
      pumping: false,
      pump: undefined,
      readyWarnings: [],
      firstGraph: Promise.resolve(),
      settleFirst: undefined,
      rescanListeners: new Set<() => void>(),
      ended: Promise.resolve(),
    };
    watch.firstGraph = new Promise<void>((resolve) => {
      watch.settleFirst = resolve;
    });
    const previous = this.current;
    this.current = watch;
    previous?.stop.abort();
    this.log.info(`watch ${String(watch.generation)}: starting in ${root}`);
    watch.ended = this.run(watch, root, previous);
    return watch.firstGraph;
  }

  private async run(watch: Watch, root: string, previous: Watch | undefined): Promise<void> {
    let session: EngineSession | undefined;
    let failed = '';
    try {
      if (previous !== undefined) await previous.ended;
      if (!this.isCurrent(watch)) return;

      failed = 'cannot read the configuration';
      const workspace = await loadWorkspaceConfig(root);
      if (!this.isCurrent(watch)) return;

      const { config } = workspace;
      this.log.info(
        `watch ${String(watch.generation)}: store ${config.consumers.store}, debounce ${String(config.watch.trailingMs)}/${String(config.watch.ceilingMs)} ms`,
      );
      this.log.debug('configuration', config);
      for (const warning of workspace.warnings) this.log.warn(`configuration: ${warning}`);
      const engine = this.options.createEngine({
        version: this.options.version,
        consumers: config.consumers,
      });

      failed = 'cannot open the graph store';
      const { host, port, graph } = config.store;
      session = await engine.connect({ host, port, graph }, { readOnly: false });
      this.log.debug(`watch ${String(watch.generation)}: store connected`);
      if (!this.isCurrent(watch)) return;

      const resources: WatchResources = { workspace, engine, session };

      failed = 'the watch stopped';
      await engine.watch(
        {
          config: {
            ...config,
            trailingMs: config.watch.trailingMs,
            ceilingMs: config.watch.ceilingMs,
            rescanIntervalMs: config.watch.rescanIntervalMs,
          },
          session,
          rescan: {
            subscribe: (listener) => {
              watch.rescanListeners.add(listener);
              return () => {
                watch.rescanListeners.delete(listener);
              };
            },
          },
        },
        (event) => this.onEvent(watch, resources, event),
        watch.stop.signal,
      );
    } catch (thrown) {
      if (this.isCurrent(watch)) {
        this.fail(`CPG: ${failed}: ${serializeError(thrown).message}`, thrown);
      } else {
        this.log.debug(
          `watch ${String(watch.generation)} ended after it was replaced`,
          asError(thrown),
        );
      }
    } finally {
      watch.live = false;
      watch.pending = undefined;
      if (watch.pump !== undefined) await watch.pump;
      if (session !== undefined) {
        try {
          await session.close();
        } catch (thrown) {
          if (!this.disposed) {
            this.fail(
              `CPG: cannot close the graph store: ${serializeError(thrown).message}`,
              thrown,
            );
          }
        }
      }
      watch.settleFirst?.();
      this.log.info(`watch ${String(watch.generation)}: ended`);
    }
  }

  private onEvent(watch: Watch, resources: WatchResources, event: WatchEvent): void {
    if (!this.isCurrent(watch)) return;
    switch (event.kind) {
      case 'ready': {
        const { report } = event;
        this.log.info(
          `indexed ${String(report.files.length)} files: ${String(report.nodesWritten)} nodes, ${String(report.edgesWritten)} edges in ${String(Math.round(report.durationMs))} ms (seq ${String(event.seq)})`,
        );
        watch.readyWarnings = report.warnings;
        this.refresh(watch, resources, event.seq);
        return;
      }
      case 'batch':
        this.log.info(
          `changes at seq ${String(event.seq)}: ${String(event.changes.length)} file(s); ${String(event.write.nodesWritten)} nodes, ${String(event.write.edgesWritten)} edges written`,
        );
        this.log.debug('batch', { changes: event.changes, latencyMs: event.latencyMs });
        this.refresh(watch, resources, event.seq);
        return;
      case 'warning':
        this.warn(`CPG: ${event.message}`);
        return;
      case 'error':
        this.fail(`CPG: the watch stopped: ${event.error.message}`, event.error);
        return;
      case 'closed':
        this.log.info(`watch ${String(watch.generation)}: closed`);
        watch.live = false;
        return;
    }
  }

  private refresh(watch: Watch, resources: WatchResources, seq: number): void {
    watch.pending = seq;
    if (!watch.pumping) {
      watch.pumping = true;
      watch.pump = this.pump(watch, resources);
    }
  }

  private async pump(watch: Watch, resources: WatchResources): Promise<void> {
    try {
      while (this.isCurrent(watch) && watch.pending !== undefined) {
        const seq = watch.pending;
        watch.pending = undefined;
        // oxlint-disable-next-line no-await-in-loop -- refreshes run one at a time, latest-wins
        await this.refreshOnce(watch, resources, seq);
        watch.settleFirst?.();
      }
    } finally {
      watch.pumping = false;
    }
  }

  private async refreshOnce(watch: Watch, resources: WatchResources, seq: number): Promise<void> {
    const start = performance.now();
    try {
      const payload = await resources.engine.inspect(resources.session, resources.workspace.config);
      if (this.isCurrent(watch)) {
        await this.deliver(watch, resources.workspace, { ...payload, seq });
        this.log.debug(
          `graph at seq ${String(seq)}: ${String(payload.nodes.length)} nodes, ${String(payload.edges.length)} edges, delivered in ${elapsed(start)} ms`,
        );
      } else {
        this.log.trace(`graph at seq ${String(seq)} dropped: its watch was replaced`);
      }
    } catch (thrown) {
      if (this.isCurrent(watch)) {
        this.fail(`CPG: the graph refresh failed: ${serializeError(thrown).message}`, thrown);
      }
    }
  }

  private async deliver(
    watch: Watch,
    workspace: WorkspaceConfig,
    payload: GraphPayload,
  ): Promise<void> {
    if (!watch.delivered) {
      watch.delivered = true;
      const probe = workspaceProbe(this.options.fileSystem, workspace.config);
      if (this.judge === undefined) this.judge = this.newJudge(probe);
      else this.judge.probe = probe;
      await this.host.onSnapshot(payload, { seq: payload.seq, cause: 'initial' });
      const warnings = [...workspace.warnings, ...watch.readyWarnings];
      if (warnings.length > 0 && this.isCurrent(watch)) {
        this.warn(`CPG: ${warnings.join('; ')}`);
      }
      return;
    }
    await this.host.onSnapshot(payload, { seq: payload.seq, cause: 'catch-up' });
  }

  private newJudge(probe: FilesystemProbe): Judge {
    const judge: Judge = {
      probe,
      scheduler: new VerifyScheduler({
        verify: () => this.host.verify(judge.probe),
        onReport: (report) => {
          const failing = report.checks.filter((check) => check.state === 'fail');
          this.log.info(
            `verify at seq ${String(report.seq)}: ${report.state}${failing.length > 0 ? ` (failing: ${failing.map((check) => check.id).join(', ')})` : ''}`,
          );
          for (const check of report.checks) {
            this.log.debug(
              `  ${check.id}: ${check.state} ${String(check.observed)}/${String(check.expected)}${check.detail === undefined ? '' : ` - ${check.detail}`}`,
            );
          }
          this.options.onReport(report);
        },
        onError: (thrown) =>
          this.fail(`CPG: verify failed: ${serializeError(thrown).message}`, thrown),
        after: this.options.after,
        current: (report) => report.epoch === this.host.epoch() && report.seq === this.host.seq(),
      }),
    };
    return judge;
  }
}
