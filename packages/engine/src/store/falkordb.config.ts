/**
 * cpg's FalkorDB configuration — the only cpg-specific thing left about how
 * this project talks to FalkorDB.
 *
 * The client, the service facade and the whole server lifecycle live in
 * `falkordb-service`, which knows FalkorDB and nothing about cpg. This file
 * supplies the parameters that make it speak cpg's language:
 *
 *   - the `CPG_` env prefix, so `CPG_CACHE_DIR` and `CPG_REDIS_SERVER` keep
 *     working exactly as documented
 *   - `CPG_FALKORDB_PLATFORM`, which does not follow the prefix pattern and is
 *     therefore named explicitly rather than renamed
 *   - `~/.cache/cpg` as the module cache namespace
 *   - remedies that name `engine.db.mode` / `engine.db.host` / `engine.db.port`,
 *     which are the settings a cpg user actually has in cpg.config.yaml
 *
 * Engine purity still applies: nothing here imports `vscode`.
 */

import {
  defineFalkorConfig,
  envNames,
  type FalkorBranding,
  type FalkorConfig,
  type FalkorConfigInput,
  type FalkorEnvNames,
} from "falkordb-service";

// Re-exported so `packages/cli`/`packages/vscode` — which depend only on
// `@cpg/engine`, never on `falkordb-service` directly — can name these types
// (e.g. building a `FalkorConfigInput` from resolved settings) without a
// second workspace dependency.
export type { FalkorConfig, FalkorConfigInput };

/** How falkordb-service should name cpg's settings when it reports a failure. */
export const CPG_BRANDING: FalkorBranding = {
  productName: "cpg",
  envPrefix: "CPG",
  cacheNamespace: "cpg",
  modeSetting: "`engine.db.mode`",
  hostSetting: "`engine.db.host`",
  portSetting: "`engine.db.port`",
};

/**
 * The env vars cpg reads. All but one follow the `CPG_` prefix; the platform
 * override is `CPG_FALKORDB_PLATFORM` because that is what is documented and
 * what users already have in their shells.
 */
export const CPG_ENV_NAMES: FalkorEnvNames = {
  ...envNames(CPG_BRANDING.envPrefix),
  platform: "CPG_FALKORDB_PLATFORM",
};

/**
 * Build a FalkorDB config branded for cpg. Callers pass the cpg-side values
 * they know (the graph key, `engine.db.*` from cpg.config.yaml); everything
 * else still falls back to the `CPG_` environment and then to the package
 * defaults.
 *
 * The `"cpg"` graph name is supplied as a `defaults.connection.graph`, not as
 * `connection.graph` directly. That distinction used to be a live bug: an
 * `input.connection.graph` value always wins over `CPG_GRAPH` by design (an
 * explicit override must win), and this function used to pass `graph: "cpg"`
 * as exactly that kind of override — every call site, meaning `CPG_GRAPH`
 * could never take effect no matter what a user set it to. `defaults` sits
 * below the env var, not above it, so `CPG_GRAPH` now actually works.
 */
export function defineCpgFalkorConfig(input: FalkorConfigInput = {}): FalkorConfig {
  return defineFalkorConfig({
    ...input,
    branding: { ...CPG_BRANDING, ...input.branding },
    envNames: { ...CPG_ENV_NAMES, ...input.envNames },
    // A nested merge, deliberately: `{ ...input.defaults, connection: {...} }`
    // would let a caller-supplied `defaults.connection` (e.g.
    // `defineCpgDevFalkorConfig`'s host/port) silently drop `graph: "cpg"`,
    // since object spread only merges at the top level.
    defaults: {
      ...input.defaults,
      connection: { graph: "cpg", ...input.defaults?.connection },
    },
  });
}

/**
 * The cpg-owned, persistent FalkorDB `docker/falkordb.dev.yml` publishes —
 * where a real `cpg index` writes. Explicitly none of: 6379 (the
 * conventional dev instance `defineFalkorConfig`'s own `remote`-mode default
 * would otherwise point at — see CLAUDE.md), 6380 (the ast-demo benchmark),
 * or 6381 (this repo's own integration-test harness, which hard-refuses any
 * graph key not prefixed `cpg_test_`).
 */
export const CPG_DEV_ENDPOINT = { host: "127.0.0.1", port: 6382 } as const;

/**
 * `defineCpgFalkorConfig`, but defaulted at the dev instance instead of
 * `defineFalkorConfig`'s own `remote`-mode default (127.0.0.1:6379). Without
 * this, a zero-config `cpg index` would write into whatever is on 6379 —
 * exactly the `falkordb-local` stack CLAUDE.md says never to touch.
 *
 * Still just defaults: `CPG_HOST`/`CPG_PORT` and an explicit `connection`
 * input both still win, same as `defineCpgFalkorConfig`.
 */
export function defineCpgDevFalkorConfig(input: FalkorConfigInput = {}): FalkorConfig {
  return defineCpgFalkorConfig({
    ...input,
    defaults: {
      ...input.defaults,
      server: { mode: "remote", ...input.defaults?.server },
      connection: { ...CPG_DEV_ENDPOINT, ...input.defaults?.connection },
    },
  });
}
