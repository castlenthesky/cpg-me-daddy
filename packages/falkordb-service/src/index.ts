/**
 * falkordb-service — a reusable FalkorDB client, service facade and server
 * lifecycle.
 *
 * The package knows FalkorDB and nothing about any one application. Everything
 * an application would otherwise hard-code — env var names, the cache
 * directory, the wording of error remedies — is a parameter on `FalkorConfig`.
 *
 * Start here:
 *
 * ```ts
 * import { FalkorService } from "falkordb-service";
 *
 * const falkor = await FalkorService.start({
 *   branding: { productName: "myapp", envPrefix: "MYAPP", cacheNamespace: "myapp" },
 *   server: { mode: "spawned" },
 *   connection: { graph: "myapp_graph" },
 * });
 * ```
 */

export * from "./config";
export { FalkorClient, now, type Timed } from "./client";
export { FalkorService, type FalkorServiceDeps } from "./service";
export { GraphService } from "./services/graph";
export { AdminService } from "./services/admin";
export * from "./services/server/index";
