/**
 * The only file in this package that names `@parcel/watcher` — the adopted
 * default (`40-research.yaml` `adopted_defaults.watcher`; the same watching
 * engine VS Code itself uses). Loaded via a dynamic `import()` so merely
 * importing `@cpg/engine` (or `./index.ts`) never pulls in a native module —
 * only actually calling `watchWorkspace` does. This also keeps a future
 * esbuild VSIX bundle (M3) from trying to inline a `.node` file.
 */
import type { RawEvent, WatchBackend, WatchSubscription } from "./backend";

export const parcelWatchBackend: WatchBackend = {
  async subscribe(root, onEvents, options): Promise<WatchSubscription> {
    const { subscribe } = await import("@parcel/watcher");
    const subscription = await subscribe(
      root,
      (err, events) => {
        if (err) {
          options.onError?.(err);
          return;
        }
        const raw: RawEvent[] = events.map((e) => ({ type: e.type, path: e.path }));
        onEvents(raw);
      },
      { ignore: [...options.ignore] },
    );
    return {
      async unsubscribe(): Promise<void> {
        await subscription.unsubscribe();
      },
    };
  },
};
