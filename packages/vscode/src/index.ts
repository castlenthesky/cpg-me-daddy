/**
 * @cpg/vscode — pure, host-free helpers.
 *
 * Anything in this module must run outside the extension host so it can be
 * covered by `bun test`. Code that needs the `vscode` API lives in
 * ./extension.ts, which is exercised by the @vscode/test-cli host tests (M3).
 */

import {
  defineCpgFalkorConfig,
  engineIdentity,
  isServerError,
  type FalkorConfigInput,
  type IndexProgress,
  type IndexReport,
} from "@cpg/engine";

/** Semantic version of the extension package. */
export const EXTENSION_VERSION = "0.0.1";

/** Identifier the command palette entry is registered under. */
export const SHOW_VERSION_COMMAND = "cpg.showVersion";

/** Identifier the command that reveals the CPG output channel. */
export const SHOW_LOG_COMMAND = "cpg.showLog";

/** Name of the output channel activation and future logging write to. */
export const LOG_CHANNEL_NAME = "CPG";

/** Text shown by the `cpg.showVersion` command. */
export function versionMessage(): string {
  return `@cpg/vscode@${EXTENSION_VERSION} / ${engineIdentity()}`;
}

/** Plain data `activationSummary` needs from the extension host. */
export interface ActivationContext {
  /** Names of the currently open workspace folders, in order. Empty if none. */
  readonly workspaceFolders: readonly string[];
}

/**
 * Lines logged to the "CPG" output channel on activation. Takes only plain
 * data so it is testable with `bun test`, without importing `vscode` — the
 * `vscode.workspace.workspaceFolders` lookup itself belongs in extension.ts.
 *
 * This only *resolves and reports* the db config; it never connects.
 * Indexing is a deliberate, user-invoked action (`cpg.indexWorkspace`), not
 * something activation does on its own.
 */
export function activationSummary(context: ActivationContext): readonly string[] {
  const db = defineCpgFalkorConfig();
  const folders =
    context.workspaceFolders.length === 0
      ? "no workspace folder open"
      : `${context.workspaceFolders.length} workspace folder(s): ${context.workspaceFolders.join(", ")}`;
  return [
    `@cpg/vscode@${EXTENSION_VERSION} activated / ${engineIdentity()}`,
    folders,
    `engine.db: mode=${db.server.mode} host=${db.connection.host} port=${db.connection.port} graph=${db.connection.graph} (resolved, not connected)`,
  ];
}

/** Identifier the "CPG: Index Workspace" command is registered under. */
export const INDEX_WORKSPACE_COMMAND = "cpg.indexWorkspace";

/**
 * Which folder `cpg.indexWorkspace` should index. Node ids are workspace-
 * relative (`path:kind:scope`), so two open roots that each contain e.g.
 * `src/index.ts` would collide — indexing more than one folder into the same
 * graph is a correctness bug, not a missing feature, so this always picks
 * exactly one.
 */
export type FolderChoice =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly index: number }
  | { readonly kind: "pick" };

/** `preselected` is the folder name from an explicit command argument (a future context-menu invocation), if any. */
export function chooseWorkspaceFolder(
  folders: readonly string[],
  preselected?: string,
): FolderChoice {
  if (folders.length === 0) {
    return { kind: "none" };
  }
  if (preselected !== undefined) {
    const index = folders.indexOf(preselected);
    if (index !== -1) {
      return { kind: "one", index };
    }
  }
  return folders.length === 1 ? { kind: "one", index: 0 } : { kind: "pick" };
}

/** The shape of `vscode.WorkspaceConfiguration.inspect()`'s result — just the levels this command reads. */
export interface SettingInspection<T> {
  readonly workspaceFolderValue?: T;
  readonly workspaceValue?: T;
  readonly globalValue?: T;
}

export interface CpgSettingsSnapshot {
  readonly mode?: SettingInspection<string>;
  readonly host?: SettingInspection<string>;
  readonly port?: SettingInspection<number>;
  readonly graph?: SettingInspection<string>;
}

function explicitValue<T>(s: SettingInspection<T> | undefined): T | undefined {
  return s?.workspaceFolderValue ?? s?.workspaceValue ?? s?.globalValue;
}

const VALID_SERVER_MODES = new Set(["spawned", "remote", "docker"]);

/**
 * Builds a `FalkorConfigInput` from ONLY the settings a user actually set —
 * never their defaults. `defineFalkorConfig` resolves `input ?? env ?? ...`,
 * so passing a setting's *default* value here would shadow `CPG_PORT` (or
 * any other env var) for a user who never touched the setting at all. This
 * is why `inspect()`, not `get()`, is the right VS Code API for this job.
 */
export function explicitDbOverrides(settings: CpgSettingsSnapshot): FalkorConfigInput {
  const host = explicitValue(settings.host);
  const port = explicitValue(settings.port);
  const graph = explicitValue(settings.graph);
  const modeRaw = explicitValue(settings.mode);
  const mode = modeRaw !== undefined && VALID_SERVER_MODES.has(modeRaw) ? modeRaw : undefined;

  const hasConnection = host !== undefined || port !== undefined || graph !== undefined;
  return {
    ...(hasConnection ? { connection: { host, port, graph } } : {}),
    ...(mode !== undefined ? { server: { mode: mode as "spawned" | "remote" | "docker" } } : {}),
  };
}

export interface ProgressTick {
  readonly message: string;
  /** Percentage points to add since the last emitted tick. */
  readonly increment: number;
}

/**
 * Throttles `IndexProgress` events to at most one every 100ms, so a
 * 5,000-file index doesn't flood `vscode.Progress.report()`. Returns
 * `undefined` when the tick should be suppressed; the caller only advances
 * its own `last` state when a tick is actually returned.
 */
export function nextProgressTick(
  progress: Pick<IndexProgress, "filesTotal" | "filesDone" | "currentFile">,
  last: { readonly percent: number; readonly atMs: number },
  nowMs: number,
): ProgressTick | undefined {
  const isFinal = progress.filesTotal > 0 && progress.filesDone >= progress.filesTotal;
  if (!isFinal && nowMs - last.atMs < 100) {
    return undefined;
  }
  const percent =
    progress.filesTotal > 0 ? Math.floor((progress.filesDone / progress.filesTotal) * 100) : 0;
  const increment = Math.max(0, percent - last.percent);
  const message =
    progress.currentFile !== undefined
      ? `Indexed ${progress.filesDone}/${progress.filesTotal}: ${progress.currentFile}`
      : `Indexed ${progress.filesDone}/${progress.filesTotal}`;
  return { message, increment };
}

/** The lines logged to the CPG channel and shown in the completion notification. */
export function indexReportLines(report: IndexReport): readonly string[] {
  const lines = [
    `cpg: indexed ${report.root}`,
    `  ${report.filesIndexed} file(s) · ${report.nodesWritten} nodes · ${report.edgesWritten} edges ` +
      `(${(report.durationMs / 1000).toFixed(1)}s)`,
  ];
  for (const warning of report.warnings) {
    lines.push(`  skipped: ${warning.message}`);
  }
  if (report.cancelled) {
    lines.push("  (cancelled)");
  }
  return lines;
}

/** The one-line summary shown in the completion toast. */
export function indexSummary(report: IndexReport): string {
  if (report.cancelled) {
    return `CPG: indexing cancelled after ${report.filesIndexed} file(s).`;
  }
  return `CPG: indexed ${report.filesIndexed} file(s) — ${report.nodesWritten} nodes, ${report.edgesWritten} edges.`;
}

export interface SurfacedError {
  readonly message: string;
  readonly detail: readonly string[];
  readonly actions: readonly string[];
}

/**
 * Turns whatever `indexWorkspace`/`openCpgStore` threw into something a user
 * can act on. Never throws itself — a catch block's last line must not need
 * its own catch block.
 */
export function surfaceIndexError(
  error: unknown,
  where: { host: string; port: number },
): SurfacedError {
  if (isServerError(error)) {
    return {
      message: `CPG: could not reach the dev FalkorDB at ${where.host}:${where.port}.`,
      detail: [error.message, `  -> ${error.remedy}`],
      actions: ["Show Log", "Copy start command", "Open Settings"],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: `CPG: indexing failed — ${message}`,
    detail: [message],
    actions: ["Show Log"],
  };
}
