/**
 * `engine.db.mode: remote` — the user already runs FalkorDB; cpg only connects.
 * Owns no lifecycle: `stop()` deliberately does nothing.
 */

import { ping, type CommandOptions } from "./redis";
import { ServerError, type ServerHandle, type ServerManager } from "./types";

export interface RemoteServerOptions {
  host?: string;
  port?: number;
  /** How long the reachability check may take before it is called a failure. */
  connectTimeoutMs?: number;
  /** Skip the reachability probe and hand back the endpoint unchecked. */
  probe?: boolean;
}

export class RemoteServerManager implements ServerManager {
  readonly mode = "remote" as const;
  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly probe: boolean;

  constructor(options: RemoteServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 6379;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    this.probe = options.probe ?? true;
  }

  async start(): Promise<ServerHandle> {
    const target: CommandOptions = {
      host: this.host,
      port: this.port,
      timeoutMs: this.connectTimeoutMs,
    };
    if (this.probe && !(await ping(target))) {
      throw new ServerError(
        "remote_unreachable",
        `No FalkorDB answered PING at ${this.host}:${this.port} within ${this.connectTimeoutMs} ms.`,
        {
          remedy:
            "Check `engine.db.host` / `engine.db.port` and that the server is running and reachable " +
            "(firewall, container port mapping, VPN). To have cpg run FalkorDB itself, set " +
            "`engine.db.mode` to `docker` or `spawned`.",
        },
      );
    }
    return {
      mode: this.mode,
      endpoint: { host: this.host, port: this.port },
      stop: async (): Promise<void> => {
        // Remote servers are not ours to stop.
      },
    };
  }
}
