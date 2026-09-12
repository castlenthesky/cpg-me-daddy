/**
 * The one place this package reads the environment.
 *
 * Every parameter the client, the service and the server lifecycle need is
 * declared here once and defaulted from an environment variable. Nothing
 * downstream touches `process.env` — `client.ts`, `service.ts` and everything
 * under `services/` take an already-resolved `FalkorConfig` and use it
 * verbatim. That is what makes the package testable off-host (pass a fake
 * `env`) and what keeps "where does this value come from?" a single-file
 * question.
 *
 * Env var NAMES are themselves configurable, because a host application wants
 * its own prefix: cpg reads `CPG_CACHE_DIR`, not `FALKORDB_CACHE_DIR`. See
 * `FalkorBranding` and `envNames()`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  FALKORDB_IMAGE,
  FALKORDB_VERSION,
  isPlatformKey,
  PLATFORM_KEYS,
  releaseBaseUrl,
  type PlatformKey,
} from "./services/server/manifest";
import type { ServerMode } from "./services/server/types";

/**
 * How this package names itself in the host application's world: env var
 * prefix, cache namespace, and the setting names quoted back at the user in
 * error remedies.
 *
 * A remedy that says "set `engine.db.mode` to `docker`" is only useful inside
 * cpg. The same failure inside another project must name that project's own
 * setting, so the strings are parameters, not constants.
 */
export interface FalkorBranding {
  /** Product name quoted in remedies, e.g. `"cpg"`. */
  readonly productName: string;
  /** Env var prefix, e.g. `"CPG"` produces `CPG_CACHE_DIR`. */
  readonly envPrefix: string;
  /** Directory under the cache root, e.g. `"cpg"` produces `~/.cache/cpg`. */
  readonly cacheNamespace: string;
  /** How the host names its mode setting, quoted in remedies. */
  readonly modeSetting: string;
  /** How the host names its host setting, quoted in remedies. */
  readonly hostSetting: string;
  /** How the host names its port setting, quoted in remedies. */
  readonly portSetting: string;
}

export const DEFAULT_BRANDING: FalkorBranding = {
  productName: "falkordb-service",
  envPrefix: "FALKORDB",
  cacheNamespace: "falkordb",
  modeSetting: "`mode`",
  hostSetting: "`host`",
  portSetting: "`port`",
};

/**
 * The env var each parameter reads. Derived from `envPrefix` by default; a
 * host overrides individual entries when its established name does not follow
 * the pattern (cpg's platform override is `CPG_FALKORDB_PLATFORM`, not
 * `CPG_PLATFORM`, and renaming it would break documented behaviour).
 */
export interface FalkorEnvNames {
  readonly host: string;
  readonly port: string;
  readonly password: string;
  readonly graph: string;
  readonly queryTimeoutMs: string;
  readonly mode: string;
  readonly readyTimeoutMs: string;
  readonly redisServer: string;
  readonly image: string;
  readonly dockerPath: string;
  readonly cacheDir: string;
  readonly version: string;
  readonly platform: string;
  readonly releaseBaseUrl: string;
}

/** Default env var names for a prefix. `FALKORDB` -> `FALKORDB_CACHE_DIR`, etc. */
export function envNames(prefix: string = DEFAULT_BRANDING.envPrefix): FalkorEnvNames {
  const p = prefix.trim().replace(/_+$/, "");
  return {
    host: `${p}_HOST`,
    port: `${p}_PORT`,
    password: `${p}_PASSWORD`,
    graph: `${p}_GRAPH`,
    queryTimeoutMs: `${p}_QUERY_TIMEOUT_MS`,
    mode: `${p}_MODE`,
    readyTimeoutMs: `${p}_READY_TIMEOUT_MS`,
    redisServer: `${p}_REDIS_SERVER`,
    image: `${p}_IMAGE`,
    dockerPath: `${p}_DOCKER`,
    cacheDir: `${p}_CACHE_DIR`,
    version: `${p}_VERSION`,
    platform: `${p}_PLATFORM`,
    releaseBaseUrl: `${p}_RELEASE_BASE_URL`,
  };
}

/** Where to reach FalkorDB, and how long to let one query run. */
export interface FalkorConnectionConfig {
  readonly host: string;
  readonly password?: string;
  /**
   * TCP port. `0` means "let the OS pick a free one" — the default for the
   * modes that start their own server, since a fixed port is exactly how two
   * concurrent runs collide. `remote` defaults to 6379 because there the port
   * is someone else's choice, not ours.
   */
  readonly port: number;
  /** Graph key. Every query the client issues is scoped to it. */
  readonly graph: string;
  /** Per-query server-side timeout, ms. */
  readonly queryTimeoutMs: number;
}

/** How a FalkorDB is obtained, and how long to wait for it. */
export interface FalkorServerConfig {
  readonly mode: ServerMode;
  /** Ceiling on the wait for the server to answer PING. */
  readonly readyTimeoutMs: number;
  /** Ceiling on a `remote` reachability probe. */
  readonly connectTimeoutMs: number;
  /** `remote` only: skip the probe and hand back the endpoint unchecked. */
  readonly probe: boolean;
  /** `spawned` only: overrides `redis-server` discovery. */
  readonly redisServerPath?: string;
  /** `spawned` only: appended to the redis-server command line. */
  readonly extraArgs: readonly string[];
  /** `docker` only: the image to run. */
  readonly image: string;
  /** `docker` only: the docker executable. */
  readonly dockerPath: string;
  /** `docker` only: extra `docker run` arguments. */
  readonly runArgs: readonly string[];
}

/** How the FalkorDB module is fetched, verified and cached. */
export interface FalkorAcquisitionConfig {
  /** Release to acquire. Bumping it needs new checksums in `manifest.ts`. */
  readonly version: string;
  /** Release asset base URL. Pointed at a fixture server in tests. */
  readonly releaseBaseUrl: string;
  /** Fully resolved cache root — no further env lookup happens downstream. */
  readonly cacheRoot: string;
  /** Pins a specific release asset, bypassing platform auto-detection. */
  readonly platformKey?: PlatformKey;
  /** Time allowed for response headers to arrive. */
  readonly connectTimeoutMs: number;
  /** Time allowed between two body chunks before the download is called stalled. */
  readonly stallTimeoutMs: number;
  /** Best-effort `com.apple.quarantine` strip on macOS. */
  readonly stripQuarantine: boolean;
}

/** Everything the package needs, fully resolved. No env reads happen after this. */
export interface FalkorConfig {
  readonly branding: FalkorBranding;
  /**
   * The env var name each parameter was read from. Carried along so that a
   * failure deep in the download or the cache can quote the variable the user
   * would actually set, without re-deriving it from the prefix.
   */
  readonly envNames: FalkorEnvNames;
  readonly connection: FalkorConnectionConfig;
  readonly server: FalkorServerConfig;
  readonly acquisition: FalkorAcquisitionConfig;
}

type Overrides<T> = { readonly [K in keyof T]?: T[K] };

/** What a caller may pass. Anything omitted falls back to env, then to a default. */
export interface FalkorConfigInput {
  /** Env source. Defaults to `process.env`; injected in tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Home directory used for the default cache root. Injected in tests. */
  readonly home?: string;
  readonly branding?: Partial<FalkorBranding>;
  /** Overrides individual env var names. Merged over `envNames(envPrefix)`. */
  readonly envNames?: Partial<FalkorEnvNames>;
  readonly connection?: Overrides<FalkorConnectionConfig>;
  readonly server?: Overrides<FalkorServerConfig>;
  readonly acquisition?: Overrides<FalkorAcquisitionConfig>;
}

const SERVER_MODES: readonly ServerMode[] = ["spawned", "remote", "docker"];

function str(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function int(env: Readonly<Record<string, string | undefined>>, name: string): number | undefined {
  const raw = str(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name}='${raw}' is not an integer.`);
  }
  return value;
}

function mode(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): ServerMode | undefined {
  const raw = str(env, name)?.toLowerCase();
  if (raw === undefined) {
    return undefined;
  }
  if (!SERVER_MODES.includes(raw as ServerMode)) {
    throw new TypeError(`${name}='${raw}' is not one of: ${SERVER_MODES.join(", ")}.`);
  }
  return raw as ServerMode;
}

/**
 * Resolve the cache root. Precedence: explicit override, then the branded
 * cache-dir env var, then `XDG_CACHE_HOME/<namespace>`, then
 * `~/.cache/<namespace>`.
 */
function resolveCacheRoot(
  env: Readonly<Record<string, string | undefined>>,
  names: FalkorEnvNames,
  namespace: string,
  home: string,
): string {
  const explicit = str(env, names.cacheDir);
  if (explicit) {
    return explicit;
  }
  const xdg = str(env, "XDG_CACHE_HOME");
  if (xdg) {
    return join(xdg, namespace);
  }
  return join(home, ".cache", namespace);
}

/** Validate a platform override the moment it is read, not at download time. */
function assertPlatformKey(value: string, names: FalkorEnvNames): PlatformKey {
  if (!isPlatformKey(value)) {
    throw new TypeError(
      `${names.platform}='${value}' is not a known FalkorDB platform key. ` +
        `Use one of: ${PLATFORM_KEYS.join(", ")}.`,
    );
  }
  return value;
}

/**
 * Build a fully-resolved config. This is the only function in the package that
 * reads the environment.
 *
 * ```ts
 * const config = defineFalkorConfig({
 *   branding: { envPrefix: "CPG", cacheNamespace: "cpg", productName: "cpg" },
 *   connection: { graph: "my_graph" },
 * });
 * ```
 */
export function defineFalkorConfig(input: FalkorConfigInput = {}): FalkorConfig {
  const env = input.env ?? process.env;
  const branding: FalkorBranding = { ...DEFAULT_BRANDING, ...input.branding };
  const names: FalkorEnvNames = { ...envNames(branding.envPrefix), ...input.envNames };
  const home = input.home ?? homedir();

  const platformRaw = input.acquisition?.platformKey ?? str(env, names.platform);
  const version = input.acquisition?.version ?? str(env, names.version) ?? FALKORDB_VERSION;
  const serverMode = input.server?.mode ?? mode(env, names.mode) ?? "remote";
  // `remote` talks to a server someone else configured, so it assumes the
  // conventional Redis port. The modes that start their own server ask the OS
  // for a free one instead, so two runs cannot fight over 6379.
  const defaultPort = serverMode === "remote" ? 6379 : 0;

  return {
    branding,
    envNames: names,
    connection: {
      host: input.connection?.host ?? str(env, names.host) ?? "127.0.0.1",
      port: input.connection?.port ?? int(env, names.port) ?? defaultPort,
      password: input.connection?.password ?? str(env, names.password),
      graph: input.connection?.graph ?? str(env, names.graph) ?? "falkordb",
      queryTimeoutMs: input.connection?.queryTimeoutMs ?? int(env, names.queryTimeoutMs) ?? 30_000,
    },
    server: {
      mode: serverMode,
      readyTimeoutMs: input.server?.readyTimeoutMs ?? int(env, names.readyTimeoutMs) ?? 15_000,
      connectTimeoutMs: input.server?.connectTimeoutMs ?? 2_000,
      probe: input.server?.probe ?? true,
      redisServerPath: input.server?.redisServerPath ?? str(env, names.redisServer),
      extraArgs: input.server?.extraArgs ?? [],
      image: input.server?.image ?? str(env, names.image) ?? FALKORDB_IMAGE,
      dockerPath: input.server?.dockerPath ?? str(env, names.dockerPath) ?? "docker",
      runArgs: input.server?.runArgs ?? [],
    },
    acquisition: {
      version,
      releaseBaseUrl:
        input.acquisition?.releaseBaseUrl ??
        str(env, names.releaseBaseUrl) ??
        releaseBaseUrl(version),
      cacheRoot:
        input.acquisition?.cacheRoot ?? resolveCacheRoot(env, names, branding.cacheNamespace, home),
      platformKey: platformRaw === undefined ? undefined : assertPlatformKey(platformRaw, names),
      connectTimeoutMs: input.acquisition?.connectTimeoutMs ?? 30_000,
      stallTimeoutMs: input.acquisition?.stallTimeoutMs ?? 60_000,
      stripQuarantine: input.acquisition?.stripQuarantine ?? true,
    },
  };
}
