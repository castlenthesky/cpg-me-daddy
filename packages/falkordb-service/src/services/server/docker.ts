/**
 * `docker` mode — run the pinned `falkordb/falkordb` image.
 *
 * This is the only mode that needs neither a platform-specific release asset
 * nor a local `redis-server`, which is why it is the recommended fallback in
 * every `unsupported_platform` and `redis_server_not_found` remedy.
 */

import { execFile } from "node:child_process";

import type { FalkorConfig } from "../../config";
import { findFreePort, sendCommand, waitForReady } from "./redis";
import { dockerMissingRemedy, dockerStartRemedy } from "./remedies";
import { ServerError, type ServerHandle, type ServerManager } from "./types";

export interface DockerServerDeps {
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

  constructor(
    private readonly config: FalkorConfig,
    private readonly deps: DockerServerDeps = {},
  ) {}

  async start(): Promise<ServerHandle> {
    const { image, dockerPath: docker, runArgs, readyTimeoutMs } = this.config.server;
    const { host } = this.config.connection;
    const log = this.deps.log ?? ((): void => {});
    const configured = this.config.connection.port;
    const port = configured > 0 ? configured : await findFreePort(host);

    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await run(docker, [
        "run",
        "--detach",
        "--rm",
        "--publish",
        `${host}:${port}:6379`,
        ...runArgs,
        image,
      ]);
    } catch (cause) {
      throw new ServerError("docker_not_found", `Could not execute '${docker}'.`, {
        remedy: dockerMissingRemedy(this.config.branding),
        cause,
      });
    }
    if (result.code !== 0) {
      throw new ServerError("server_start_failed", `\`docker run ${image}\` failed.`, {
        remedy: dockerStartRemedy(this.config.branding),
        detail: (result.stderr || result.stdout).trim().slice(-2_000),
      });
    }

    const containerId = result.stdout.trim();
    log(`Started ${image} as ${containerId.slice(0, 12)} on ${host}:${port}`);

    try {
      await waitForReady({
        branding: this.config.branding,
        host,
        port,
        readyTimeoutMs,
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
