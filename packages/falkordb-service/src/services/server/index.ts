/**
 * The server lifecycle sub-service.
 *
 * Picks the right `ServerManager` for the configured mode, starts it, and
 * remembers the handle so the facade can stop it again. This is the one piece
 * of the package that runs *before* there is a client to inject — the endpoint
 * it produces is what the client is then built from.
 */

export * from "./types";
export * from "./manifest";
export * from "./cache";
export * from "./checksum";
export * from "./download";
export * from "./acquire";
export * from "./redis";
export * from "./remedies";
export * from "./remote";
export * from "./docker";
export * from "./spawned";

import type { FalkorConfig } from "../../config";
import { DockerServerManager, type DockerServerDeps } from "./docker";
import { RemoteServerManager } from "./remote";
import { SpawnedServerManager, type SpawnedServerDeps } from "./spawned";
import type { ServerEndpoint, ServerHandle, ServerManager } from "./types";

export type ServerServiceDeps = SpawnedServerDeps & DockerServerDeps;

/** Build the manager for a configured mode. */
export function createServerManager(
  config: FalkorConfig,
  deps: ServerServiceDeps = {},
): ServerManager {
  switch (config.server.mode) {
    case "spawned":
      return new SpawnedServerManager(config, deps);
    case "docker":
      return new DockerServerManager(config, deps);
    case "remote":
      return new RemoteServerManager(config);
  }
}

export class ServerService {
  private readonly manager: ServerManager;
  private handle: ServerHandle | undefined;

  constructor(
    private readonly config: FalkorConfig,
    deps: ServerServiceDeps = {},
  ) {
    this.manager = createServerManager(config, deps);
  }

  get mode(): FalkorConfig["server"]["mode"] {
    return this.config.server.mode;
  }

  /**
   * Where the running server can be reached, or `undefined` before `start()`.
   *
   * This is not the same as the configured host/port: `spawned` and `docker`
   * default to port 0 and let the OS pick, so the endpoint is only knowable
   * after the server is up. Callers must connect to *this*, never to the
   * configured port.
   */
  get endpoint(): ServerEndpoint | undefined {
    return this.handle?.endpoint;
  }

  get modulePath(): string | undefined {
    return this.handle?.modulePath;
  }

  /** Start the server, or return the handle from a previous start. */
  async start(): Promise<ServerHandle> {
    this.handle ??= await this.manager.start();
    return this.handle;
  }

  /** Idempotent. A `remote` server is never stopped — it is not ours. */
  async stop(): Promise<void> {
    const running = this.handle;
    this.handle = undefined;
    await running?.stop();
  }
}
