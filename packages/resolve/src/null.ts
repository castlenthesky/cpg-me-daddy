// PASSTHROUGH (U6c.1a) by design: the control a harness measures against and the honest last link
// of a chain. It resolves nothing.
import type { WorkspacePath } from '@cpg/model';
import type {
  RefSite,
  ResolveBatch,
  ResolveContext,
  Resolver,
  ResolverCapabilities,
  ResolverStatus,
  ResolverWorkspace,
} from './contract';
import { unresolved } from './resolution';

/**
 * Answers every site `unresolved` with reason `no-resolver` ("I never looked", INV-14) and
 * confidence 0, one per ref in input order (INV-1). Its capabilities declare no extension and no
 * kind, so it never satisfies capability parity for a host-accelerator link (INV-4).
 *
 * - `resolve` before `open`, or after `close`, rejects `workspace-not-open` (INV-6).
 * - An already-cancelled `ctx.token` answers every site with reason `cancelled` (INV-20).
 * - Diagnostics: its id, the file, `siteCount` refs.length, backend `ready`, not degraded, 0 ms,
 *   0 timed-out sites. `status()`: `ready` while open, else `stopped`; 0 restarts, no lastError.
 */
export class NullResolver implements Resolver {
  readonly id = 'null';
  readonly precision = 'syntactic';
  readonly capabilities: ResolverCapabilities = {
    extensions: [],
    kinds: [],
    host: 'headless',
    maxConcurrentFiles: Number.POSITIVE_INFINITY,
  };
  private opened = false;

  async open(_workspace: ResolverWorkspace): Promise<void> {
    this.opened = true;
  }

  async fileChanged(_filePath: WorkspacePath, _text: string | null): Promise<void> {}

  async resolve(
    filePath: WorkspacePath,
    refs: readonly RefSite[],
    ctx?: ResolveContext,
  ): Promise<ResolveBatch> {
    if (!this.opened) throw new Error('workspace-not-open');
    const reason = ctx?.token?.isCancellationRequested ? 'cancelled' : 'no-resolver';
    return {
      resolutions: refs.map((ref) => unresolved(ref, this.id, reason)),
      diagnostics: {
        resolverId: this.id,
        filePath,
        siteCount: refs.length,
        backend: 'ready',
        degraded: false,
        elapsedMs: 0,
        timedOutSites: 0,
      },
    };
  }

  status(): ResolverStatus {
    return { resolverId: this.id, state: this.opened ? 'ready' : 'stopped', restarts: 0 };
  }

  async close(): Promise<void> {
    this.opened = false;
  }
}
