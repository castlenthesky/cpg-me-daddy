/**
 * The facade.
 *
 * `FalkorService.start()` is the one entry point most callers need. It runs
 * the whole sequence in the only order that works:
 *
 *   1. `ServerService` obtains a running FalkorDB (spawned, docker or remote)
 *   2. that yields the endpoint it actually bound — which in spawned and
 *      docker mode is a port the OS chose, not the configured one
 *   3. a single `FalkorClient` connects to *that* endpoint
 *   4. the client is injected into every sub-service
 *
 * Step 3 is why the sub-services do not build their own connections: there is
 * exactly one, it is shared, and it is closed once. Step 2 is why they cannot
 * simply read the port out of config.
 */

import { FalkorClient } from "./client";
import { defineFalkorConfig, type FalkorConfig, type FalkorConfigInput } from "./config";
import { AdminService } from "./services/admin";
import { GraphService } from "./services/graph";
import { ServerService, type ServerServiceDeps } from "./services/server/index";
import type { ServerEndpoint } from "./services/server/types";

export interface FalkorServiceDeps extends ServerServiceDeps {
  /** Injected in tests to run the services against a fake connection. */
  connect?: (config: FalkorConfig, endpoint: ServerEndpoint) => Promise<FalkorClient>;
}

function defaultConnect(config: FalkorConfig, endpoint: ServerEndpoint): Promise<FalkorClient> {
  return FalkorClient.connect({
    ...config.connection,
    host: endpoint.host,
    port: endpoint.port,
  });
}

export class FalkorService {
  private constructor(
    readonly config: FalkorConfig,
    readonly client: FalkorClient,
    readonly server: ServerService,
    readonly graph: GraphService,
    readonly admin: AdminService,
  ) {}

  /**
   * Resolve config, bring up a server, connect, and wire the sub-services.
   *
   * ```ts
   * const falkor = await FalkorService.start({
   *   server: { mode: "spawned" },
   *   connection: { graph: "my_graph" },
   * });
   * const n = await falkor.graph.scalar("MATCH (n) RETURN count(n)");
   * await falkor.close();
   * ```
   */
  static async start(
    input: FalkorConfigInput | FalkorConfig = {},
    deps: FalkorServiceDeps = {},
  ): Promise<FalkorService> {
    const config = isResolved(input) ? input : defineFalkorConfig(input);
    const server = new ServerService(config, deps);

    const handle = await server.start();
    try {
      const client = await (deps.connect ?? defaultConnect)(config, handle.endpoint);
      return new FalkorService(
        config,
        client,
        server,
        new GraphService(client),
        new AdminService(client),
      );
    } catch (error) {
      // A server we started and cannot connect to is a leak, not a result.
      await server.stop();
      throw error;
    }
  }

  /** Where the client is actually connected. See `ServerService.endpoint`. */
  get endpoint(): ServerEndpoint | undefined {
    return this.server.endpoint;
  }

  /**
   * Close the connection, then stop the server if this service started one.
   * In `remote` mode the second step is a no-op — that server is not ours.
   */
  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      await this.server.stop();
    }
  }
}

function isResolved(input: FalkorConfigInput | FalkorConfig): input is FalkorConfig {
  return "branding" in input && "envNames" in input && "acquisition" in input;
}
