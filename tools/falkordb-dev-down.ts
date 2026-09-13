/**
 * Stops the dev FalkorDB. Unlike `falkordb-down.ts` (the test harness, which
 * always runs `down -v`), this defaults to keeping the volume: the whole
 * point of `docker/falkordb.dev.yml` is that a real index survives being
 * stopped.
 *
 * `--destroy` (also requiring `CPG_DEV_DB_DESTROY=1`) runs `down -v` and
 * actually deletes the data. Two separate gates — the flag and the env var —
 * because this script runs non-interactively; there is no reliable prompt to
 * confirm against, so the env var is the confirmation.
 */

import { takeDownComposeInstance } from "./lib/compose-instance.ts";

const COMPOSE_FILE = "docker/falkordb.dev.yml";
const INSTANCE_FILE = ".tmp/falkordb-dev-instance.json";

const destroy = process.argv.includes("--destroy");

if (destroy && process.env.CPG_DEV_DB_DESTROY !== "1") {
  process.stderr.write(
    "\n--destroy also requires CPG_DEV_DB_DESTROY=1, so this can never fire by accident:\n" +
      "  CPG_DEV_DB_DESTROY=1 bun run db:dev:reset\n" +
      "This permanently deletes the cpg-dev-falkordb-data volume — every real index it holds.\n\n",
  );
  process.exit(1);
}

const status = takeDownComposeInstance(
  { composeFile: COMPOSE_FILE, instanceFile: INSTANCE_FILE },
  { removeVolumes: destroy },
);
process.exit(status);
