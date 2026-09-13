/**
 * @cpg/cli — the `cpg` command line interface.
 *
 * Depends on @cpg/engine; the dependency never points the other way.
 * `main.ts` is the actual `bin` entry (a shebang wrapper around `run`); this
 * file must not self-execute — `test/unit/version.test.ts` imports it.
 */

export { CLI_VERSION, versionBanner } from "./version";
export { run } from "./run";
