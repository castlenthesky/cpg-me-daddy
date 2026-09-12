/**
 * `redis-server` discovery and a minimal RESP client.
 *
 * FalkorDB ships only a Redis module, so spawned mode needs a `redis-server`
 * executable the FalkorDB project does not provide. When there isn't one, the
 * user must be told exactly that — X14(4): never a silent hang.
 *
 * The client here is deliberately tiny: enough to PING, to wait for readiness,
 * and to SHUTDOWN NOSAVE. The real RESP wrapper over GRAPH.QUERY is F2's job.
 */

import { accessSync, constants } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { delimiter, join } from "node:path";

import { ServerError } from "./types";

/** Looked at after `$PATH`, in order. Covers Homebrew (both prefixes) and distro packages. */
export const COMMON_REDIS_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/opt/local/bin",
  "/snap/bin",
];

export interface DiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected in tests. Default: `X_OK` access check. */
  isExecutable?: (path: string) => boolean;
  /** Extra directories searched before the common ones. */
  extraDirs?: readonly string[];
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const NO_REDIS_REMEDY =
  "FalkorDB is distributed as a Redis module (a .so), not as a standalone server, so spawned mode " +
  "needs a `redis-server` executable on your machine. Either install one " +
  "(macOS: `brew install redis`; Debian/Ubuntu: `apt install redis-server`; Alpine: `apk add redis`), " +
  "point cpg at one with CPG_REDIS_SERVER=/path/to/redis-server, or switch `engine.db.mode` to " +
  "`docker` (no local Redis needed) or `remote` (use a FalkorDB you already run).";

/**
 * Find `redis-server`. Precedence: `CPG_REDIS_SERVER`, then `$PATH`, then the
 * common install prefixes. Throws `redis_server_not_found` with the remedy above.
 */
export function findRedisServer(options: DiscoveryOptions = {}): string {
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;

  const explicit = env.CPG_REDIS_SERVER?.trim();
  if (explicit) {
    if (isExecutable(explicit)) {
      return explicit;
    }
    throw new ServerError(
      "redis_server_not_found",
      `CPG_REDIS_SERVER='${explicit}' is not an executable file.`,
      { remedy: NO_REDIS_REMEDY },
    );
  }

  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const dirs = [...(options.extraDirs ?? []), ...pathDirs, ...COMMON_REDIS_DIRS];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    const candidate = join(dir, "redis-server");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new ServerError(
    "redis_server_not_found",
    "No `redis-server` executable found on PATH or in the usual install locations.",
    { remedy: NO_REDIS_REMEDY },
  );
}

/** Encode a RESP array command. */
export function encodeCommand(args: readonly string[]): string {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  }
  return out;
}

export interface CommandOptions {
  host?: string;
  port: number;
  timeoutMs?: number;
}

/**
 * Send one command and return the first reply line (RESP simple status / error
 * without the leading byte parsed out — callers here only need to see `+PONG`).
 */
export function sendCommand(args: readonly string[], options: CommandOptions): Promise<string> {
  const host = options.host ?? "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? 2_000;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const socket: Socket = connect({ host, port: options.port });
    let buffer = "";
    const done = (err: Error | undefined, value?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(value ?? "");
      }
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`timed out after ${timeoutMs} ms`)));
    socket.on("error", (err) => done(err));
    socket.on("connect", () => socket.write(encodeCommand(args)));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\r\n");
      if (end !== -1) {
        done(undefined, buffer.slice(0, end));
      }
    });
    socket.on("close", () => {
      // SHUTDOWN closes the connection without replying; that is success.
      done(undefined, buffer.split("\r\n")[0] ?? "");
    });
  });
}

/** One PING. Resolves true only on `+PONG`. */
export async function ping(options: CommandOptions): Promise<boolean> {
  try {
    const reply = await sendCommand(["PING"], options);
    return reply === "+PONG";
  } catch {
    return false;
  }
}

export interface ReadinessOptions extends CommandOptions {
  /** Hard ceiling on the wait — X14(4)'s "not a silent hang". */
  readyTimeoutMs?: number;
  intervalMs?: number;
  /**
   * Called between attempts. Returning false aborts the wait immediately —
   * this is how a redis-server that aborted on a bad module (the 0644 trap)
   * surfaces in milliseconds instead of at the timeout.
   */
  isAlive?: () => boolean;
  onGiveUp?: () => string | undefined;
}

/** Poll PING until the server answers, the process dies, or the deadline passes. */
export async function waitForReady(options: ReadinessOptions): Promise<void> {
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + readyTimeoutMs;

  for (;;) {
    if (options.isAlive && !options.isAlive()) {
      throw new ServerError(
        "server_start_failed",
        `redis-server exited before it became ready on port ${options.port}.`,
        {
          remedy:
            "The server log below usually says why. A module without execute permission " +
            "('It does not have execute permissions') means the cached .so lost its +x bit — " +
            "delete the cpg cache directory and let cpg re-acquire it.",
          detail: options.onGiveUp?.(),
        },
      );
    }
    // Sequential by nature: a readiness poll, not parallelisable work.
    // eslint-disable-next-line no-await-in-loop
    const alive = await ping({
      host: options.host,
      port: options.port,
      timeoutMs: options.timeoutMs ?? 500,
    });
    if (alive) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new ServerError(
        "server_not_ready",
        `FalkorDB did not answer PING on ${options.host ?? "127.0.0.1"}:${options.port} within ${readyTimeoutMs} ms.`,
        {
          remedy:
            "Check the server log below, then retry. If the port is already taken by another " +
            "Redis, choose a different `engine.db.port` or use `engine.db.mode: remote`.",
          detail: options.onGiveUp?.(),
        },
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Ask the OS for a free TCP port. Used when no explicit port is configured. */
export function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
