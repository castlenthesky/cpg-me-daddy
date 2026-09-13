/**
 * Starts the pinned FalkorDB the integration suite runs against, and proves
 * the published port actually reaches the container we started — see
 * `tools/lib/compose-instance.ts` for why (a foreign container can already
 * own the port, and `docker compose up -d` failing with "port is already
 * allocated" does not stop `PING` on that port from answering, from that
 * *other* container).
 *
 * The nonce lands in .tmp/falkordb-instance.json, which
 * packages/engine/test/support/falkordb.ts checks before the first test.
 */

import { HARNESS_NONCE_KEY, harnessTarget } from "../packages/engine/test/support/falkordb.ts";
import { bringUpComposeInstance } from "./lib/compose-instance.ts";

const target = harnessTarget();

async function main(): Promise<void> {
  await bringUpComposeInstance({
    label: "harness",
    composeFile: "docker/falkordb.yml",
    service: "falkordb",
    target,
    nonceKey: HARNESS_NONCE_KEY,
    guardGraph: "cpg_test_guard",
    instanceFile: ".tmp/falkordb-instance.json",
    upFailureRemedy:
      'If that says "port is already allocated", another container owns the port. Do NOT\n' +
      "assume the harness can use it: a PING there will answer, from that other container.\n" +
      "Stop the other container, or set the port in docker/falkordb.yml and\n" +
      "CPG_TEST_FALKORDB_PORT to a free one.",
    portMismatchRemedy: "Align docker/falkordb.yml with CPG_TEST_FALKORDB_PORT.",
    uiFallbackPort: 3033,
    uiEnvVar: "CPG_TEST_FALKORDB_UI_PORT",
    uiLabel: "read-only, cpg_test_* graphs only",
  });
}

// Not top-level await: the workspace root has no "type": "module", so this file
// is a CommonJS module and an unhandled rejection here would print a stack
// trace instead of the actionable message bringUpComposeInstance's die() gives.
main().catch((e: unknown) => {
  process.stderr.write(
    `\nFalkorDB harness did not start.\n${e instanceof Error ? e.message : String(e)}\n\n`,
  );
  process.exit(1);
});
