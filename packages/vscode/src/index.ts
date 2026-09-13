/**
 * @cpg/vscode — pure, host-free helpers.
 *
 * Anything in this module must run outside the extension host so it can be
 * covered by `bun test`. Code that needs the `vscode` API lives in
 * ./extension.ts, which is exercised by the @vscode/test-cli host tests (M3).
 */

import { defineCpgFalkorConfig, engineIdentity } from "@cpg/engine";

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
 * This only *resolves and reports* the db config; it never connects. There is
 * nothing to index or query yet (M0.1/M0.2/M0.11-lite are not started), so an
 * activation-time connection attempt would be premature.
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
