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
 */
export function defineCpgFalkorConfig(input: FalkorConfigInput = {}): FalkorConfig {
  return defineFalkorConfig({
    ...input,
    branding: { ...CPG_BRANDING, ...input.branding },
    envNames: { ...CPG_ENV_NAMES, ...input.envNames },
    connection: { graph: "cpg", ...input.connection },
  });
}
