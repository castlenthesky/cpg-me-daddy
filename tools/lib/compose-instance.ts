/**
 * The four-step "actually prove this is our container" handshake, shared by
 * `tools/falkordb-up.ts` (the integration harness) and
 * `tools/falkordb-dev-up.ts` (the cpg-owned dev instance).
 *
 * Extracted verbatim from the harness script, which predates this file —
 * change no control flow here, add no "skip the nonce if…" branch. The
 * harness's own guarantee is enforced on the READ side, in
 * `packages/engine/test/support/falkordb.ts`, which this file does not touch;
 * `bun run db:up && bun run test:integration && bun run db:down` is the
 * regression test for any change here.
 *
 * `harnessTarget()`/`HARNESS_NONCE_KEY` deliberately do NOT live here and
 * have no defaults in this file's types — a caller must always supply its
 * own target and nonce key, so no instance can inherit the harness's
 * identity by omission.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { FalkorClient } from "../../packages/falkordb-service/src/client.ts";

export interface ComposeInstanceTarget {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
}

export interface InstanceRecord {
  readonly nonce: string;
  readonly host: string;
  readonly port: number;
  readonly containerId: string;
  readonly image: string;
  readonly startedAt: string;
}

export interface ComposeInstanceSpec {
  /** Used only in messages, e.g. "harness" / "dev". */
  readonly label: string;
  readonly composeFile: string;
  readonly service: string;
  readonly target: ComposeInstanceTarget;
  readonly nonceKey: string;
  /** Graph key the provenance round-trip connects to. Never the real data graph. */
  readonly guardGraph: string;
  readonly instanceFile: string;
  readonly readyTimeoutMs?: number;
  /** Appended to the message when `up -d` exits non-zero. */
  readonly upFailureRemedy: string;
  /** Appended to the message when the published port doesn't match `target.port`. */
  readonly portMismatchRemedy: string;
  /** Container port the FalkorDB Browser listens on. Default 3000. */
  readonly uiContainerPort?: number;
  readonly uiFallbackPort: number;
  readonly uiEnvVar: string;
  /** e.g. "read-only, cpg_test_* graphs only" or "READ-WRITE — real data". */
  readonly uiLabel: string;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_UI_CONTAINER_PORT = 3000;

function die(label: string, message: string): never {
  process.stderr.write(`\nFalkorDB ${label} did not start.\n${message}\n\n`);
  process.exit(1);
}

function run(
  cmd: string,
  args: string[],
  label: string,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) {
    die(label, `Could not run \`${cmd}\`: ${r.error.message}`);
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Waits for the server to accept connections, then checks the nonce.
 *
 * Retries are inherently sequential — each attempt must observe the previous
 * one's failure before deciding to sleep — so the awaits below cannot be
 * collected into a Promise.all.
 */
/* eslint-disable no-await-in-loop -- a bounded retry loop is sequential by nature */
async function awaitProvenance(spec: ComposeInstanceSpec, nonce: string): Promise<void> {
  const { target, label, nonceKey, guardGraph } = spec;
  const readyTimeoutMs = spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = "";
  for (;;) {
    try {
      const client = await FalkorClient.connect({
        host: target.host,
        port: target.port,
        password: target.password,
        graph: guardGraph,
        queryTimeoutMs: 5_000,
      });
      try {
        const seen = await client.raw<string | null>(["GET", nonceKey]);
        if (seen !== nonce) {
          die(
            label,
            `the server answering ${target.host}:${target.port} is NOT the container just started.\n` +
              `  ${nonceKey} read back as ${seen === null ? "unset" : `"${seen}"`}, expected "${nonce}".\n` +
              "  Another process owns that port. Stop it before running against this instance.",
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
          label,
          `gave up waiting for ${target.host}:${target.port} after ${readyTimeoutMs}ms: ${lastError}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
/* eslint-enable no-await-in-loop */

/**
 * Brings up `spec.composeFile`'s `spec.service`, verifies it is the
 * container that was just started (not a stranger already bound to the
 * port), and returns the record also written to `spec.instanceFile`.
 */
export async function bringUpComposeInstance(spec: ComposeInstanceSpec): Promise<InstanceRecord> {
  const { label, composeFile, service, target } = spec;
  const compose = (...args: string[]) =>
    run("docker", ["compose", "-f", composeFile, ...args], label);

  // 1. up — a non-zero exit is fatal, never something to poll past.
  const up = compose("up", "-d");
  process.stdout.write(up.stdout);
  process.stderr.write(up.stderr);
  if (up.code !== 0) {
    die(
      label,
      `\`docker compose -f ${composeFile} up -d\` exited ${up.code}.\n${spec.upFailureRemedy}`,
    );
  }

  // 2. the container must actually be running.
  const idOut = compose("ps", "-q", service);
  const containerId = idOut.stdout.trim().split("\n")[0] ?? "";
  if (idOut.code !== 0 || containerId === "") {
    die(label, `compose reports no container for service "${service}".\n${idOut.stderr}`);
  }
  const state = run(
    "docker",
    ["inspect", "-f", "{{.State.Status}}", containerId],
    label,
  ).stdout.trim();
  if (state !== "running") {
    const logs = run("docker", ["logs", "--tail", "30", containerId], label);
    die(
      label,
      `container ${containerId.slice(0, 12)} is "${state}", not "running".\n${logs.stderr}${logs.stdout}`,
    );
  }

  // 3. the published port must be the one this instance will be dialed on.
  const published = compose("port", service, "6379").stdout.trim();
  const publishedPort = Number(published.split(":").pop());
  if (!Number.isFinite(publishedPort) || publishedPort !== target.port) {
    die(
      label,
      `compose published ${service}:6379 on "${published}" but the target port is ${target.port}.\n` +
        spec.portMismatchRemedy,
    );
  }

  // 4. provenance handshake: stamp inside the container, read back over TCP.
  const nonce = randomBytes(16).toString("hex");
  const stamp = run(
    "docker",
    ["exec", containerId, "redis-cli", "SET", spec.nonceKey, nonce],
    label,
  );
  if (stamp.code !== 0 || !stamp.stdout.includes("OK")) {
    die(
      label,
      `could not stamp the provenance nonce inside the container.\n${stamp.stderr}${stamp.stdout}`,
    );
  }

  await awaitProvenance(spec, nonce);

  const record: InstanceRecord = {
    nonce,
    host: target.host,
    port: target.port,
    containerId,
    image: run("docker", ["inspect", "-f", "{{.Config.Image}}", containerId], label).stdout.trim(),
    startedAt: new Date().toISOString(),
  };
  const path = join(process.cwd(), spec.instanceFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

  process.stdout.write(
    `FalkorDB ${label} ready: ${record.image} on ${target.host}:${target.port} ` +
      `(container ${containerId.slice(0, 12)}, provenance verified).\n`,
  );

  // The Browser is a nice-to-have, not part of the provenance guarantee
  // above: report whatever compose actually published, falling back to the
  // configured default if the query fails, rather than failing the whole
  // script over it.
  const uiContainerPort = spec.uiContainerPort ?? DEFAULT_UI_CONTAINER_PORT;
  const uiPortEnv = Number(process.env[spec.uiEnvVar]);
  const configuredUiPort = Number.isFinite(uiPortEnv) ? uiPortEnv : spec.uiFallbackPort;
  const publishedUi = compose("port", service, String(uiContainerPort)).stdout.trim();
  const uiPort = Number(publishedUi.split(":").pop());
  process.stdout.write(
    `FalkorDB Browser (${spec.uiLabel}): ` +
      `http://${target.host}:${Number.isFinite(uiPort) ? uiPort : configuredUiPort}\n`,
  );

  return record;
}

/** `docker compose -f composeFile down [-v]`, then removes `instanceFile`. */
export function takeDownComposeInstance(
  spec: Pick<ComposeInstanceSpec, "composeFile" | "instanceFile">,
  options: { readonly removeVolumes: boolean },
): number {
  const args = [
    "compose",
    "-f",
    spec.composeFile,
    "down",
    ...(options.removeVolumes ? ["-v"] : []),
  ];
  const r = spawnSync("docker", args, { stdio: "inherit" });
  rmSync(join(process.cwd(), spec.instanceFile), { force: true });
  return r.status ?? 0;
}
