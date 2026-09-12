/**
 * @cpg/cli — the `cpg` command line interface.
 *
 * Depends on @cpg/engine; the dependency never points the other way.
 */

import { engineIdentity } from "@cpg/engine";

/** Semantic version of the CLI package. */
export const CLI_VERSION = "0.0.1";

/** The string printed by `cpg --version`. */
export function versionBanner(): string {
  return `@cpg/cli@${CLI_VERSION} / ${engineIdentity()}`;
}
