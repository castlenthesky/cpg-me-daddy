/**
 * Split out of index.ts so `run.ts` can depend on it without a cycle:
 * index.ts re-exports `run`, so `run.ts` importing back from `index.ts`
 * would be circular.
 */
import { engineIdentity } from "@cpg/engine";

/** Semantic version of the CLI package. */
export const CLI_VERSION = "0.0.1";

/** The string printed by `cpg --version`. */
export function versionBanner(): string {
  return `@cpg/cli@${CLI_VERSION} / ${engineIdentity()}`;
}
