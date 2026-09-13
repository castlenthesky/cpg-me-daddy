/**
 * Starts the pinned FalkorDB the integration suite runs against, and proves the
 * published port actually reaches the container we started.
 *
 * Why this is a script and not just `docker compose up -d`:
 *
 *   `docker compose up -d` can print an error and leave the container dead
 *   because another container already owns the port — and a `PING` to that port
 *   still answers, from the *other* container. Plain compose plus a naive
 *   readiness poll therefore reports success while the suite is pointed at
 *   somebody else's database.
 *
 * So after `up` we:
 *   1. hard-fail on a non-zero compose exit (no "well, something answered");
 *   2. confirm the container is actually in state `running`;
 *   3. ask compose which host port it published, and refuse a surprise;
 *   4. write a random nonce into the container over the container's own
 *      loopback (`docker exec`), then read it back over the published TCP port.
 *      Matching proves the route. Nothing on the far side can forge it.
 *
 * The nonce lands in .tmp/falkordb-instance.json, which
 * packages/engine/test/support/falkordb.ts checks before the first test.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HARNESS_NONCE_KEY, harnessTarget } from "../packages/engine/test/support/falkordb.ts";
import { FalkorClient } from "../packages/falkordb-service/src/client.ts";

const COMPOSE_FILE = "docker/falkordb.yml";
const SERVICE = "falkordb";
const INSTANCE_FILE = ".tmp/falkordb-instance.json";
const READY_TIMEOUT_MS = 30_000;
const DEFAULT_UI_PORT = 3000;

function die(message: string): never {
  process.stderr.write(`\nFalkorDB harness did not start.\n${message}\n\n`);
  process.exit(1);
}

function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) {
    die(`Could not run \`${cmd}\`: ${r.error.message}`);
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function compose(...args: string[]): { code: number; stdout: string; stderr: string } {
  return run("docker", ["compose", "-f", COMPOSE_FILE, ...args]);
}

/**
 * Waits for the server to accept connections, then checks the nonce.
 *
 * Retries are inherently sequential — each attempt must observe the previous
 * one's failure before deciding to sleep — so the awaits below cannot be
 * collected into a Promise.all.
 */
/* eslint-disable no-await-in-loop -- a bounded retry loop is sequential by nature */
async function awaitProvenance(
  target: ReturnType<typeof harnessTarget>,
  nonce: string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "";
  for (;;) {
    try {
      const client = await FalkorClient.connect({
        host: target.host,
        port: target.port,
        password: target.password,
        graph: "cpg_test_guard",
        queryTimeoutMs: 5_000,
      });
      try {
        const seen = await client.raw<string | null>(["GET", HARNESS_NONCE_KEY]);
        if (seen !== nonce) {
          die(
            `the server answering ${target.host}:${target.port} is NOT the container just started.\n` +
              `  ${HARNESS_NONCE_KEY} read back as ${seen === null ? "unset" : `"${seen}"`}, expected "${nonce}".\n` +
              "  Another process owns that port. Stop it before running the integration suite.",
          );
        }
      } finally {
        await client.close();
      }
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (Date.now() > deadline) {
        die(
          `gave up waiting for ${target.host}:${target.port} after ${READY_TIMEOUT_MS}ms: ${lastError}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
/* eslint-enable no-await-in-loop */

async function main(): Promise<void> {
  // 1. up — a non-zero exit is fatal, never something to poll past.
  const up = compose("up", "-d");
  process.stdout.write(up.stdout);
  process.stderr.write(up.stderr);
  if (up.code !== 0) {
    die(
      `\`docker compose -f ${COMPOSE_FILE} up -d\` exited ${up.code}.\n` +
        'If that says "port is already allocated", another container owns the port. Do NOT\n' +
        "assume the harness can use it: a PING there will answer, from that other container.\n" +
        "Stop the other container, or set the port in docker/falkordb.yml and\n" +
        "CPG_TEST_FALKORDB_PORT to a free one.",
    );
  }

  // 2. the container must actually be running.
  const idOut = compose("ps", "-q", SERVICE);
  const containerId = idOut.stdout.trim().split("\n")[0] ?? "";
  if (idOut.code !== 0 || containerId === "") {
    die(`compose reports no container for service "${SERVICE}".\n${idOut.stderr}`);
  }
  const state = run("docker", ["inspect", "-f", "{{.State.Status}}", containerId]).stdout.trim();
  if (state !== "running") {
    const logs = run("docker", ["logs", "--tail", "30", containerId]);
    die(
      `container ${containerId.slice(0, 12)} is "${state}", not "running".\n${logs.stderr}${logs.stdout}`,
    );
  }

  // 3. the published port must be the one the harness will dial.
  const target = harnessTarget();
  const published = compose("port", SERVICE, "6379").stdout.trim();
  const publishedPort = Number(published.split(":").pop());
  if (!Number.isFinite(publishedPort) || publishedPort !== target.port) {
    die(
      `compose published ${SERVICE}:6379 on "${published}" but the harness dials port ${target.port}.\n` +
        "Align docker/falkordb.yml with CPG_TEST_FALKORDB_PORT.",
    );
  }

  // 4. provenance handshake: stamp inside the container, read back over TCP.
  const nonce = randomBytes(16).toString("hex");
  const stamp = run("docker", ["exec", containerId, "redis-cli", "SET", HARNESS_NONCE_KEY, nonce]);
  if (stamp.code !== 0 || !stamp.stdout.includes("OK")) {
    die(
      `could not stamp the provenance nonce inside the container.\n${stamp.stderr}${stamp.stdout}`,
    );
  }

  await awaitProvenance(target, nonce);

  const record = {
    nonce,
    host: target.host,
    port: target.port,
    containerId,
    image: run("docker", ["inspect", "-f", "{{.Config.Image}}", containerId]).stdout.trim(),
    startedAt: new Date().toISOString(),
  };
  const path = join(process.cwd(), INSTANCE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

  process.stdout.write(
    `FalkorDB harness ready: ${record.image} on ${target.host}:${target.port} ` +
      `(container ${containerId.slice(0, 12)}, provenance verified).\n`,
  );

  // The Browser is a nice-to-have, not part of the provenance guarantee above:
  // report whatever compose actually published, falling back to the configured
  // default if the query fails, rather than failing the whole script over it.
  const uiPortEnv = Number(process.env.CPG_TEST_FALKORDB_UI_PORT);
  const configuredUiPort = Number.isFinite(uiPortEnv) ? uiPortEnv : DEFAULT_UI_PORT;
  const publishedUi = compose("port", SERVICE, "3000").stdout.trim();
  const uiPort = Number(publishedUi.split(":").pop());
  const uiHost = target.host;
  process.stdout.write(
    `FalkorDB Browser (read-only, cpg_test_* graphs only): http://${uiHost}:${Number.isFinite(uiPort) ? uiPort : configuredUiPort}\n`,
  );
}

// Not top-level await: the workspace root has no "type": "module", so this file
// is a CommonJS module and an unhandled rejection here would print a stack
// trace instead of the actionable message die() gives.
main().catch((e: unknown) => {
  die(e instanceof Error ? e.message : String(e));
});
