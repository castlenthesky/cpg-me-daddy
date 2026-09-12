/**
 * `engine.db.mode: spawned` — cpg acquires the FalkorDB module and runs it
 * under a local `redis-server`.
 *
 * SP11 asked: single binary, or `redis-server --loadmodule`? FalkorDB publishes
 * no standalone server binary at all (see `manifest.ts`), so the answer is
 * forced: `redis-server --loadmodule <cached .so>`. The consequence is that
 * this mode depends on an executable FalkorDB does not ship, and most of the
 * error handling below exists to say so clearly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { acquireFalkorModule, type AcquireOptions, type AcquiredModule } from "./acquire";
import { findFreePort, findRedisServer, sendCommand, waitForReady } from "./redis";
import { ServerError, type ServerHandle, type ServerManager } from "./types";

export interface SpawnedServerOptions extends AcquireOptions {
  host?: string;
  /** 0 or omitted means "pick a free port". */
  port?: number;
  /** Overrides discovery. Otherwise `CPG_REDIS_SERVER` / PATH / common prefixes. */
  redisServerPath?: string;
  readyTimeoutMs?: number;
  /** Appended to the redis-server command line (e.g. FalkorDB tuning flags). */
  extraArgs?: readonly string[];
}

/** Keep the tail of the child's output so a failure can quote it back. */
const LOG_TAIL_BYTES = 4_000;

class LogTail {
  private buffer = "";
  append(chunk: string): void {
    this.buffer = (this.buffer + chunk).slice(-LOG_TAIL_BYTES);
  }
  toString(): string {
    return this.buffer.trim();
  }
}

export interface SpawnedStartResult extends ServerHandle {
  readonly module: AcquiredModule;
}

export class SpawnedServerManager implements ServerManager {
  readonly mode = "spawned" as const;
  private readonly options: SpawnedServerOptions;

  constructor(options: SpawnedServerOptions = {}) {
    this.options = options;
  }

  async start(): Promise<SpawnedStartResult> {
    const host = this.options.host ?? "127.0.0.1";
    const log = this.options.log ?? ((): void => {});

    // Order matters: the platform check inside acquire() is what produces the
    // X14(3) Windows message, and it must fire before anything touches the
    // network or the filesystem.
    const acquired = await acquireFalkorModule(this.options);
    const redisServer = this.options.redisServerPath ?? findRedisServer({ env: this.options.env });
    const port =
      this.options.port && this.options.port > 0 ? this.options.port : await findFreePort(host);

    const args = [
      "--port",
      String(port),
      "--bind",
      host,
      "--loadmodule",
      acquired.path,
      // A cpg graph is a rebuildable cache (PR3): persistence would only cost
      // fsyncs and leave dump.rdb litter in the user's cwd.
      "--save",
      "",
      "--appendonly",
      "no",
      ...(this.options.extraArgs ?? []),
    ];

    log(`Spawning ${redisServer} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(redisServer, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      throw new ServerError("server_start_failed", `Could not spawn '${redisServer}'.`, {
        remedy:
          "Check the redis-server path (CPG_REDIS_SERVER) or switch `engine.db.mode` to `docker` " +
          "or `remote`.",
        cause,
      });
    }

    const tail = new LogTail();
    child.stdout?.on("data", (chunk: Buffer) => tail.append(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => tail.append(chunk.toString("utf8")));

    let exited = false;
    let spawnError: Error | undefined;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", (error) => {
      exited = true;
      spawnError = error;
    });

    try {
      await waitForReady({
        host,
        port,
        readyTimeoutMs: this.options.readyTimeoutMs ?? 15_000,
        isAlive: () => !exited,
        onGiveUp: () => {
          const text = tail.toString();
          return spawnError ? `${spawnError.message}\n${text}` : text || undefined;
        },
      });
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }

    log(`FalkorDB ready on ${host}:${port} (pid ${child.pid})`);

    let stopped = false;
    return {
      mode: this.mode,
      endpoint: { host, port },
      modulePath: acquired.path,
      runtimeId: child.pid === undefined ? undefined : String(child.pid),
      module: acquired,
      stop: async (): Promise<void> => {
        if (stopped || exited) {
          stopped = true;
          return;
        }
        stopped = true;
        // SHUTDOWN NOSAVE is the clean path: redis exits without writing an RDB.
        await sendCommand(["SHUTDOWN", "NOSAVE"], { host, port, timeoutMs: 2_000 }).catch(
          () => undefined,
        );
        if (!exited) {
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          timer.unref?.();
          try {
            await once(child, "exit");
          } finally {
            clearTimeout(timer);
          }
        }
      },
    };
  }
}
