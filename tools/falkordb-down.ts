/**
 * Stops the harness FalkorDB and removes the provenance record, so a later run
 * cannot match a nonce from an instance that is gone.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const r = spawnSync("docker", ["compose", "-f", "docker/falkordb.yml", "down", "-v"], {
  encoding: "utf8",
  stdio: "inherit",
});
rmSync(join(process.cwd(), ".tmp/falkordb-instance.json"), { force: true });
process.exit(r.status ?? 0);
