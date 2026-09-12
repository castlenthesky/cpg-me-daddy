/**
 * @cpg/vscode — pure, host-free helpers.
 *
 * Anything in this module must run outside the extension host so it can be
 * covered by `bun test`. Code that needs the `vscode` API lives in
 * ./extension.ts, which is exercised by the @vscode/test-cli host tests (M3).
 */

import { engineIdentity } from "@cpg/engine";

/** Semantic version of the extension package. */
export const EXTENSION_VERSION = "0.0.1";

/** Identifier the command palette entry is registered under. */
export const SHOW_VERSION_COMMAND = "cpg.showVersion";

/** Text shown by the `cpg.showVersion` command. */
export function versionMessage(): string {
  return `@cpg/vscode@${EXTENSION_VERSION} / ${engineIdentity()}`;
}
