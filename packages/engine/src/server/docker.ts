/**
 * `engine.db.mode: docker` — run the pinned `falkordb/falkordb` image.
 *
 * This is the only mode that needs neither a platform-specific release asset
 * nor a local `redis-server`, which is why it is the recommended fallback in
 * every `unsupported_platform` and `redis_server_not_found` remedy.
 */

import { execFile } from "node:child_process";

import { FALKORDB_IMAGE } from "./manifest";
import { findFreePort, sendCommand, waitForReady } from "./redis";
import { ServerError, type ServerHandle, type ServerManager } from "./types";

export interface DockerServerOptions {
  image?: string;
  host?: string;
  /** 0 or omitted means "pick a free port". */
  port?: number;
  /** Docker executable. Default `docker` resolved via PATH. */
  dockerPath?: string;
  readyTimeoutMs?: number;
  /** Extra `docker run` arguments, e.g. FalkorDB tuning flags. */
  runArgs?: readonly string[];
  log?: (message: string) => void;
}

function run(
  bin: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(error);
        return;
      }
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

export class DockerServerManager implements ServerManager {
  readonly mode = "docker" as const;
  private readonly options: DockerServerOptions;

  constructor(options: DockerServerOptions = {}) {
    this.options = options;
  }

  async start(): Promise<ServerHandle> {
    const docker = this.options.dockerPath ?? "docker";
    const image = this.options.image ?? FALKORDB_IMAGE;
    const host = this.options.host ?? "127.0.0.1";
    const log = this.options.log ?? ((): void => {});
    const port =
      this.options.port && this.options.port > 0 ? this.options.port : await findFreePort(host);

    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await run(docker, [
        "run",
        "--detach",
        "--rm",
        "--publish",
        `${host}:${port}:6379`,
        ...(this.options.runArgs ?? []),
        image,
      ]);
    } catch (cause) {
      throw new ServerError("docker_not_found", `Could not execute '${docker}'.`, {
        remedy:
          "Install Docker and make sure the daemon is running, or switch `engine.db.mode` to " +
          "`spawned` (needs a local redis-server) or `remote`.",
        cause,
      });
    }
    if (result.code !== 0) {
      throw new ServerError("server_start_failed", `\`docker run ${image}\` failed.`, {
        remedy:
          "Check that the Docker daemon is running and that the image can be pulled, then retry. " +
          "`engine.db.mode: remote` avoids Docker entirely.",
        detail: (result.stderr || result.stdout).trim().slice(-2_000),
      });
    }

    const containerId = result.stdout.trim();
    log(`Started ${image} as ${containerId.slice(0, 12)} on ${host}:${port}`);

    try {
      await waitForReady({
        host,
        port,
        readyTimeoutMs: this.options.readyTimeoutMs ?? 30_000,
        onGiveUp: () => `container ${containerId.slice(0, 12)}`,
      });
    } catch (error) {
      await run(docker, ["stop", containerId]).catch(() => undefined);
      throw error;
    }

    let stopped = false;
    return {
      mode: this.mode,
      endpoint: { host, port },
      runtimeId: containerId,
      stop: async (): Promise<void> => {
        if (stopped) {
          return;
        }
        stopped = true;
        await sendCommand(["SHUTDOWN", "NOSAVE"], { host, port, timeoutMs: 2_000 }).catch(
          () => undefined,
        );
        await run(docker, ["stop", "--time", "5", containerId]).catch(() => undefined);
      },
    };
  }
}
