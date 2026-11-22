// REAL. The @parcel/watcher WatchBackend (C-WATCH layer A). It translates events and nothing else:
// no debounce, coalescing, dedupe, hashing, lstat or content reads (C-WATCH may_not). The native
// module loads by dynamic import on the first subscribe, so importing @cpg/watch loads no .node file.
//
// Measured on Linux inotify (06-measurements M-RESEARCH-watcher-linux): parcel itself merges events
// per path inside its ~50 ms window, renames arrive as delete + create, and a file created right
// after its new parent directory can go unreported. Layer B owns the repair (C-WATCH OQ-9, OQ-10).
import type {
  RawWatchEvent,
  WatchBackend,
  WatchCapabilities,
  WatchError,
  WatchSubscription,
} from './contract';

/** The slice of @parcel/watcher this backend calls; a test passes a fake. */
export interface ParcelModule {
  subscribe(
    dir: string,
    callback: (
      err: Error | null,
      events: readonly { type: 'create' | 'update' | 'delete'; path: string }[],
    ) => unknown,
    options?: { ignore?: string[] },
  ): Promise<{ unsubscribe(): Promise<void> }>;
}

export interface ParcelBackendOptions {
  readonly load?: () => Promise<ParcelModule>;
  readonly now?: () => number;
  readonly platform?: string;
  /**
   * The root's real path. macOS FSEvents reports real paths (/private/var/... for a root at
   * /var/...), so events are mapped back onto the root as given. packages/watch may not import
   * node:fs (C-WATCH INV-3), so the composition root passes fs.promises.realpath. Omitted: no mapping.
   */
  readonly realpath?: (path: string) => Promise<string>;
}

const KIND = { create: 'created', update: 'changed', delete: 'deleted' } as const;

/**
 * parcel rejects an unusable root with a bare message. On Linux (2.6.0) a missing root says "Bad file
 * descriptor" and a file says "Not a directory". The backend may not stat the root to tell.
 */
const ROOT_MISSING = /bad file descriptor|not a directory|no such file|enoent/i;

const loadParcel = async (): Promise<ParcelModule> => import('@parcel/watcher');

export function createParcelWatchBackend(options: ParcelBackendOptions = {}): WatchBackend {
  const load = options.load ?? loadParcel;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const capabilities: WatchCapabilities = {
    id: 'parcel',
    directoryEvents: 'all',
    moveEvents: 'none',
    reportsErrors: true,
    reportsOverflow: false,
    honoursIgnore: 'advisory',
    pathCase: platform === 'darwin' || platform === 'win32' ? 'insensitive' : 'sensitive',
  };

  return {
    capabilities,
    async subscribe(root, onEvents, subscribeOptions = {}): Promise<WatchSubscription> {
      const { onError } = subscribeOptions;
      const report = (error: WatchError): void => onError?.(error);
      let open = true;
      const realRoot = options.realpath ? await options.realpath(root).catch(() => root) : root;
      // Only paths strictly under the root leave the backend (INV-4). FSEvents also reports the
      // root directory itself, which is not under the root.
      const underRoot = (path: string): string | undefined => {
        for (const base of [root, realRoot]) {
          if (path.startsWith(`${base}/`)) return root + path.slice(base.length);
        }
        return undefined;
      };
      let parcel: ParcelModule;
      let native: { unsubscribe(): Promise<void> };
      try {
        parcel = await load();
        native = await parcel.subscribe(
          root,
          (err, events) => {
            if (!open) return;
            if (err) {
              report({
                code: 'backend-crashed',
                message: err.message,
                fatal: false,
                rescanRequired: true,
                cause: err,
              });
              return;
            }
            const observedAt = now();
            const raw = events.flatMap((e): RawWatchEvent[] => {
              const path = underRoot(e.path);
              return path === undefined
                ? []
                : [{ kind: KIND[e.type], path, entry: 'unknown', observedAt }];
            });
            if (raw.length > 0) onEvents(raw);
          },
          subscribeOptions.ignore ? { ignore: [...subscribeOptions.ignore] } : {},
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        report({
          code: ROOT_MISSING.test(message) ? 'root-missing' : 'backend-crashed',
          message,
          fatal: true,
          rescanRequired: false,
          path: root,
          cause,
        });
        throw cause;
      }
      return {
        capabilities,
        async close() {
          if (!open) return;
          open = false;
          await native.unsubscribe();
        },
      };
    },
  };
}
