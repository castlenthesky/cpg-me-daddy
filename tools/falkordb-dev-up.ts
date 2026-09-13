/**
 * Starts the cpg-owned, persistent FalkorDB `cpg index` writes real data
 * into — see `docker/falkordb.dev.yml`'s header for why it's a separate
 * compose project from the test harness, and why it persists across restarts
 * when the harness deliberately does not.
 *
 * Same provenance handshake as the test harness (`tools/falkordb-up.ts`), for
 * the same reason plus one more: a false positive here doesn't just risk
 * reading a stranger's data, it means `cpg index` would run
 * `bootstrapSchema()` and per-file replaces against a database that isn't
 * ours.
 */

import { CPG_DEV_ENDPOINT } from "../packages/engine/src/store/falkordb.config.ts";
import { bringUpComposeInstance } from "./lib/compose-instance.ts";

async function main(): Promise<void> {
  await bringUpComposeInstance({
    label: "dev",
    composeFile: "docker/falkordb.dev.yml",
    service: "falkordb",
    target: { host: CPG_DEV_ENDPOINT.host, port: CPG_DEV_ENDPOINT.port },
    nonceKey: "cpg:dev:instance",
    guardGraph: "cpg_dev_guard",
    instanceFile: ".tmp/falkordb-dev-instance.json",
    upFailureRemedy:
      'If that says "port is already allocated", another container owns the port. Set\n' +
      "CPG_DEV_FALKORDB_PORT to a free one (and update packages/engine/src/store/" +
      "falkordb.config.ts's CPG_DEV_ENDPOINT and CPG_PORT if you want it to stay the default).",
    portMismatchRemedy: "Align docker/falkordb.dev.yml with CPG_DEV_FALKORDB_PORT.",
    uiFallbackPort: 3034,
    uiEnvVar: "CPG_DEV_FALKORDB_UI_PORT",
    uiLabel: "READ-WRITE — real data, runs arbitrary Cypher",
  });
}

// Not top-level await — see tools/falkordb-up.ts's note on why.
main().catch((e: unknown) => {
  process.stderr.write(
    `\nFalkorDB dev instance did not start.\n${e instanceof Error ? e.message : String(e)}\n\n`,
  );
  process.exit(1);
});
