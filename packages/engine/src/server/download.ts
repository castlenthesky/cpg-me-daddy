/**
 * HTTPS download with hard timeouts.
 *
 * X14(4) says an offline or unreachable download must report the problem, not
 * fail silently — and "silently" includes hanging forever. Two watchdogs run:
 * one until response headers arrive, then a rolling one that fires when the
 * body stalls. Either aborts the request and produces a `download_failed`
 * ServerError carrying a remedy.
 */

import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";

import { ServerError } from "./types";

/** Time allowed for the response headers to arrive. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** Time allowed between two body chunks before the download is called stalled. */
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DownloadOptions {
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Tests serve fixtures over plain http on loopback. Never set in product code. */
  allowInsecureUrl?: boolean;
  signal?: AbortSignal;
}

/**
 * `NO_PROXY` matching: `*` for everything, otherwise a suffix match on the
 * host, with a leading dot meaning "this domain and its subdomains".
 */
export function isProxyBypassed(hostname: string, noProxy: string | undefined): boolean {
  if (!noProxy) {
    return false;
  }
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) {
      continue;
    }
    if (entry === "*") {
      return true;
    }
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Proxy for a URL from the conventional environment variables. Lowercase wins
 * over uppercase, matching curl.
 *
 * Caveat worth knowing: Bun's `fetch` honours the `proxy` init option, Node's
 * (undici) ignores it unless a dispatcher is installed. So under the VS Code
 * extension host (Node) this resolution is advisory — it is surfaced in the
 * failure message so a proxied user is told why the download died instead of
 * being left guessing.
 */
export function resolveProxy(
  url: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (isProxyBypassed(parsed.hostname, env.NO_PROXY ?? env.no_proxy)) {
    return undefined;
  }
  const proxy =
    parsed.protocol === "https:"
      ? (env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY)
      : (env.http_proxy ?? env.HTTP_PROXY);
  return proxy?.trim() || undefined;
}

function assertSafeUrl(url: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new ServerError("download_failed", `Not a valid download URL: ${url}`, {
      remedy: "Fix the configured FalkorDB release base URL.",
      cause,
    });
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (allowInsecure && parsed.protocol === "http:") {
    return;
  }
  throw new ServerError(
    "download_failed",
    `Refusing to download the FalkorDB module over '${parsed.protocol}' (${url}).`,
    { remedy: "The FalkorDB module may only be fetched over HTTPS." },
  );
}

const OFFLINE_REMEDY =
  "cpg could not reach the FalkorDB release. Check your network or proxy " +
  "(HTTPS_PROXY/HTTP_PROXY/NO_PROXY), or avoid the download entirely by setting " +
  "`engine.db.mode` to `docker` or `remote`. If you already have the module, drop it in the " +
  "cache directory (CPG_CACHE_DIR) and cpg will verify and reuse it.";

/** fetch init plus the `proxy` option Bun understands and Node ignores. */
type ProxyableInit = RequestInit & { proxy?: string };

/**
 * Download `url` to `destPath`. The caller is responsible for verifying the
 * result before moving it anywhere the engine will load from.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
): Promise<{ bytes: number }> {
  const allowInsecure = options.allowInsecureUrl === true;
  assertSafeUrl(url, allowInsecure);

  const env = options.env ?? process.env;
  const proxy = resolveProxy(url, env);
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const controller = new AbortController();
  let timedOutWith: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (ms: number, reason: string): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timedOutWith = reason;
      controller.abort();
    }, ms);
    timer.unref?.();
  };
  const disarm = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const fail = (message: string, cause?: unknown): ServerError => {
    const withProxy = proxy ? `${message} (proxy: ${proxy})` : message;
    return new ServerError("download_failed", withProxy, { remedy: OFFLINE_REMEDY, cause });
  };

  try {
    arm(connectTimeoutMs, `no response headers within ${connectTimeoutMs} ms`);
    let response: Response;
    try {
      const init: ProxyableInit = { signal: controller.signal, redirect: "follow" };
      if (proxy) {
        init.proxy = proxy;
      }
      response = await doFetch(url, init);
    } catch (cause) {
      throw fail(
        timedOutWith ? `Timed out downloading ${url}: ${timedOutWith}.` : `Could not reach ${url}.`,
        cause,
      );
    }

    if (!response.ok) {
      throw fail(`Download of ${url} failed with HTTP ${response.status} ${response.statusText}.`);
    }
    if (!response.body) {
      throw fail(`Download of ${url} returned an empty body.`);
    }

    const sink = createWriteStream(destPath);
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        // Rolling watchdog: reset on every chunk, so a slow-but-alive transfer
        // is fine and a dead one is caught within stallTimeoutMs.
        arm(stallTimeoutMs, `no data for ${stallTimeoutMs} ms`);
        // Sequential by nature: this is a byte stream, not parallel work.
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (!sink.write(value)) {
          // eslint-disable-next-line no-await-in-loop
          await once(sink, "drain");
        }
      }
      disarm();
      await finishStream(sink);
    } catch (cause) {
      disarm();
      sink.destroy();
      await rm(destPath, { force: true });
      throw fail(
        timedOutWith
          ? `Download of ${url} stalled: ${timedOutWith}.`
          : `Download of ${url} was interrupted.`,
        cause,
      );
    }
    return { bytes };
  } finally {
    disarm();
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function finishStream(sink: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sink.once("error", reject);
    sink.end(() => resolve());
  });
}
