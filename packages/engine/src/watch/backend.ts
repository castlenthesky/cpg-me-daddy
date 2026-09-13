/**
 * The watch backend seam. `watch-workspace.ts` depends only on this — never
 * on `@parcel/watcher` directly — so a unit test can drive a fake backend
 * with no filesystem watching at all, and so a future
 * `@parcel/watcher-wasm` → chokidar fallback chain (M1.1's, deferred) has
 * one interface to implement, not a rewrite.
 */

export interface RawEvent {
  readonly type: "create" | "update" | "delete";
  /** Absolute filesystem path. */
  readonly path: string;
}

export interface WatchSubscription {
  unsubscribe(): Promise<void>;
}

export interface WatchSubscribeOptions {
  /** A coarse, best-effort pre-filter (e.g. `config.walk.exclude`) — never the authoritative
   *  boundary. `watch-workspace.ts` always re-applies the real `compileMatcher` excludes/includes
   *  to every event path before it becomes a `FilesystemDelta`; see that file's module doc. */
  readonly ignore: readonly string[];
  readonly onError?: (error: Error) => void;
}

export interface WatchBackend {
  subscribe(
    root: string,
    onEvents: (events: readonly RawEvent[]) => void,
    options: WatchSubscribeOptions,
  ): Promise<WatchSubscription>;
}
