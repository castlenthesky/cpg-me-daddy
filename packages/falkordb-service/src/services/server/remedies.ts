/**
 * Every remedy string this package can produce, as a function of the host's
 * branding.
 *
 * These used to be module-level constants naming one application's own
 * settings — advice that is only actionable inside that application. A package
 * meant for reuse cannot hard-code those names, but it also must not degrade
 * into "an error occurred": the value of this code is that every failure says
 * what to do about it. So the remedies stay just as specific, and take the
 * names to use as parameters.
 */

import type { FalkorBranding } from "../../config";

/** `switch the `mode` setting to `docker` or `remote`` in the host's own words. */
function switchMode(b: FalkorBranding, modes: string): string {
  return `set ${b.modeSetting} to ${modes}`;
}

export function noRedisServerRemedy(b: FalkorBranding, redisServerEnv: string): string {
  return (
    "FalkorDB is distributed as a Redis module (a .so), not as a standalone server, so spawned " +
    "mode needs a `redis-server` executable on your machine. Either install one " +
    "(macOS: `brew install redis`; Debian/Ubuntu: `apt install redis-server`; Alpine: `apk add redis`), " +
    `point ${b.productName} at one with ${redisServerEnv}=/path/to/redis-server, or ` +
    `${switchMode(b, "`docker` (no local Redis needed) or `remote` (use a FalkorDB you already run)")}.`
  );
}

export function windowsRemedy(b: FalkorBranding, image: string): string {
  return (
    `FalkorDB publishes no Windows build, so spawned mode cannot work on Windows. ` +
    `${switchMode(b, `\`docker\` (runs ${image})`)}, or ${switchMode(b, "`remote`")} and point ` +
    `${b.hostSetting}/${b.portSetting} at a FalkorDB you already run.`
  );
}

export function noAssetRemedy(
  b: FalkorBranding,
  platformEnv: string,
  platformKeys: readonly string[],
): string {
  return (
    `${switchMode(b, "`docker` or `remote`")}. If a FalkorDB release asset does exist for this ` +
    `platform, pin it with ${platformEnv}=<key> (one of: ${platformKeys.join(", ")}).`
  );
}

export function offlineRemedy(b: FalkorBranding, cacheDirEnv: string): string {
  return (
    `${b.productName} could not reach the FalkorDB release. Check your network or proxy ` +
    `(HTTPS_PROXY/HTTP_PROXY/NO_PROXY), or avoid the download entirely: ` +
    `${switchMode(b, "`docker` or `remote`")}. If you already have the module, drop it in the ` +
    `cache directory (${cacheDirEnv}) and ${b.productName} will verify and reuse it.`
  );
}

export function checksumMismatchRemedy(b: FalkorBranding): string {
  return (
    `${b.productName} will not load a module it cannot verify against its pinned manifest. The ` +
    "bad file has been quarantined; re-run to fetch a clean copy. If it keeps failing, your " +
    "download is being modified in transit (check your proxy/TLS interception) or the pinned " +
    "checksum is wrong for the configured release."
  );
}

export function cacheUnreadableRemedy(b: FalkorBranding): string {
  return `Check the cache directory is readable, or delete it and let ${b.productName} download again.`;
}

export function cacheChmodRemedy(path: string, cacheDirEnv: string): string {
  return (
    "redis-server refuses to load a module without execute permission. Fix the file mode " +
    `manually (chmod +x '${path}') or choose a writable ${cacheDirEnv}.`
  );
}

export function cacheWriteRemedy(cacheDirEnv: string): string {
  return `Point ${cacheDirEnv} at a writable directory.`;
}

export function dockerMissingRemedy(b: FalkorBranding): string {
  return (
    "Install Docker and make sure the daemon is running, or " +
    `${switchMode(b, "`spawned` (needs a local redis-server) or `remote`")}.`
  );
}

export function dockerStartRemedy(b: FalkorBranding): string {
  return (
    "Check that the Docker daemon is running and that the image can be pulled, then retry. " +
    `${switchMode(b, "`remote`")} avoids Docker entirely.`
  );
}

export function spawnFailedRemedy(b: FalkorBranding, redisServerEnv: string): string {
  return (
    `Check the redis-server path (${redisServerEnv}) or ` +
    `${switchMode(b, "`docker` or `remote`")}.`
  );
}

export function remoteUnreachableRemedy(b: FalkorBranding): string {
  return (
    `Check ${b.hostSetting} / ${b.portSetting} and that the server is running and reachable ` +
    `(firewall, container port mapping, VPN). To have ${b.productName} run FalkorDB itself, ` +
    `${switchMode(b, "`docker` or `spawned`")}.`
  );
}

export function moduleAbortedRemedy(b: FalkorBranding): string {
  return (
    "The server log below usually says why. A module without execute permission " +
    "('It does not have execute permissions') means the cached .so lost its +x bit — " +
    `delete the ${b.productName} cache directory and let it re-acquire the module.`
  );
}

export function notReadyRemedy(b: FalkorBranding): string {
  return (
    "Check the server log below, then retry. If the port is already taken by another " +
    `Redis, choose a different ${b.portSetting} or ${switchMode(b, "`remote`")}.`
  );
}
