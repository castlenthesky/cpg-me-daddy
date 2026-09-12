/**
 * Server lifecycle behind a `ServerManager` interface (README design rule 8),
 * with the Spawned / Remote / Docker implementations X14 calls for.
 */

export * from "./types";
export * from "./manifest";
export * from "./cache";
export * from "./checksum";
export * from "./download";
export * from "./acquire";
export * from "./redis";
export * from "./remote";
export * from "./docker";
export * from "./spawned";

import { DockerServerManager, type DockerServerOptions } from "./docker";
import { RemoteServerManager, type RemoteServerOptions } from "./remote";
import { SpawnedServerManager, type SpawnedServerOptions } from "./spawned";
import type { ServerManager, ServerMode } from "./types";

export interface ServerManagerConfig {
  /** `engine.db.mode` from cpg.config.yaml. */
  mode: ServerMode;
  spawned?: SpawnedServerOptions;
  remote?: RemoteServerOptions;
  docker?: DockerServerOptions;
}

/** Build the manager for a configured `engine.db.mode`. */
export function createServerManager(config: ServerManagerConfig): ServerManager {
  switch (config.mode) {
    case "spawned":
      return new SpawnedServerManager(config.spawned);
    case "docker":
      return new DockerServerManager(config.docker);
    case "remote":
      return new RemoteServerManager(config.remote);
  }
}
