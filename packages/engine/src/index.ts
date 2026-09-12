/**
 * @cpg/engine — the pure TypeScript core of the code property graph.
 *
 * Engine purity rule (enforced by .oxlintrc.json): nothing under
 * packages/engine may import `vscode`. The engine runs identically inside the
 * extension host, the CLI and a headless daemon, so it may not depend on any
 * editor API.
 */

/** Semantic version of the engine package. */
export const ENGINE_VERSION = "0.0.1";

/** Schema version of the graph the engine reads and writes. */
export const SCHEMA_VERSION = 0;

/** Identifies the engine build in logs and in the `cpg://schema` resource. */
export function engineIdentity(): string {
  return `@cpg/engine@${ENGINE_VERSION} (schema v${SCHEMA_VERSION})`;
}

export * from "./parser/index";
export { Client, now, type ClientConfig, type Timed } from "./store/client.js";
