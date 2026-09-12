/**
 * Server lifecycle vocabulary (README design rule 8).
 *
 * FalkorDB is a Redis module, not a database server. Everything in this
 * directory exists because of that single fact: see `manifest.ts` for the
 * release assets that prove it.
 */

/** How the engine obtains a running FalkorDB. Mirrors `engine.db.mode` in cpg.config.yaml. */
export type ServerMode = "spawned" | "remote" | "docker";

/** Where a running FalkorDB can be reached. */
export interface ServerEndpoint {
  host: string;
  port: number;
}

/** A running server the engine may talk to. `stop()` is idempotent. */
export interface ServerHandle {
  readonly mode: ServerMode;
  readonly endpoint: ServerEndpoint;
  /** Absolute path of the loaded FalkorDB module, when this manager owns one. */
  readonly modulePath?: string;
  /** Opaque handle for the underlying runtime (pid, container id) — diagnostics only. */
  readonly runtimeId?: string;
  stop(): Promise<void>;
}

/**
 * Owns the lifecycle of one FalkorDB instance. `Remote` owns nothing and only
 * checks reachability; `Docker` and `Spawned` start and stop a real process.
 */
export interface ServerManager {
  readonly mode: ServerMode;
  start(): Promise<ServerHandle>;
}

/**
 * Machine-readable failure reasons. Every one of these must produce an
 * actionable message — X14(4) forbids failing silently or hanging.
 */
export type ServerErrorCode =
  | "unsupported_platform"
  | "download_failed"
  | "checksum_mismatch"
  | "cache_write_failed"
  | "redis_server_not_found"
  | "docker_not_found"
  | "server_start_failed"
  | "server_not_ready"
  | "remote_unreachable";

export interface ServerErrorOptions {
  /** What the user should actually do about it. Always present. */
  remedy: string;
  cause?: unknown;
  /** Tail of the child process log, when there is one. */
  detail?: string;
}

/** A failure the user can act on. `message` is the headline; `remedy` is the fix. */
export class ServerError extends Error {
  readonly code: ServerErrorCode;
  readonly remedy: string;
  readonly detail?: string;

  constructor(code: ServerErrorCode, message: string, options: ServerErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServerError";
    this.code = code;
    this.remedy = options.remedy;
    this.detail = options.detail;
  }

  /** Single block suitable for a CLI stderr dump or an MCP status payload. */
  override toString(): string {
    const parts = [`${this.name} [${this.code}]: ${this.message}`, `  -> ${this.remedy}`];
    if (this.detail) {
      parts.push(`  detail: ${this.detail}`);
    }
    return parts.join("\n");
  }
}

/** Narrowing helper for callers that catch broadly. */
export function isServerError(value: unknown): value is ServerError {
  return value instanceof ServerError;
}
