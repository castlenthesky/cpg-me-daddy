/**
 * `remote` mode — the user already runs FalkorDB; this package only connects.
 * Owns no lifecycle: `stop()` deliberately does nothing.
 */

import type { FalkorConfig } from "../../config";
import { ping, type CommandOptions } from "./redis";
import { remoteUnreachableRemedy } from "./remedies";
import { ServerError, type ServerHandle, type ServerManager } from "./types";

export class RemoteServerManager implements ServerManager {
  readonly mode = "remote" as const;

  constructor(private readonly config: FalkorConfig) {}

  async start(): Promise<ServerHandle> {
    const { host, port } = this.config.connection;
    const { connectTimeoutMs, probe } = this.config.server;
    const target: CommandOptions = { host, port, timeoutMs: connectTimeoutMs };

    if (probe && !(await ping(target))) {
      throw new ServerError(
        "remote_unreachable",
        `No FalkorDB answered PING at ${host}:${port} within ${connectTimeoutMs} ms.`,
        { remedy: remoteUnreachableRemedy(this.config.branding) },
      );
    }
    return {
      mode: this.mode,
      endpoint: { host, port },
      stop: async (): Promise<void> => {
        // Remote servers are not ours to stop.
      },
    };
  }
}
