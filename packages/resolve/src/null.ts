// SEAT (U6c.1a). Once implemented this is a PASSTHROUGH by design: the control a harness measures
// against and the honest last link of a chain. It resolves nothing.
import type {
  ResolveBatch,
  ResolveContext,
  RefSite,
  Resolver,
  ResolverCapabilities,
  ResolverStatus,
  ResolverWorkspace,
} from './contract';
import type { WorkspacePath } from '@cpg/model';

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

  open(_workspace: ResolverWorkspace): Promise<void> {
    throw new Error('SEAT: NullResolver lands in U6c.1a');
  }

  fileChanged(_filePath: WorkspacePath, _text: string | null): Promise<void> {
    throw new Error('SEAT: NullResolver lands in U6c.1a');
  }

  resolve(
    _filePath: WorkspacePath,
    _refs: readonly RefSite[],
    _ctx?: ResolveContext,
  ): Promise<ResolveBatch> {
    throw new Error('SEAT: NullResolver lands in U6c.1a');
  }

  status(): ResolverStatus {
    throw new Error('SEAT: NullResolver lands in U6c.1a');
  }

  close(): Promise<void> {
    throw new Error('SEAT: NullResolver lands in U6c.1a');
  }
}
