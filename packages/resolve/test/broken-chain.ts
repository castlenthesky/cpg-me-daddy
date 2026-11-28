// The deliberately broken chain (BMO-46: "INV-10c and INV-4 shown to fail against a deliberately
// broken chain"): archive 21754b4:packages/cpg-generator/src/chain.ts's composition rule as it was,
// before C-RESOLVE. It checks no capability parity (INV-4), and a later link's open answer always
// replaces the kept one, so a dynamic answer falls back to unresolved (INV-10c). Everything else the
// chain suite checks, it gets right.
import type { WorkspacePath } from '@cpg/model';
import type {
  RefSite,
  Resolution,
  ResolveBatch,
  ResolveContext,
  Resolver,
  ResolverCapabilities,
  ResolverStatus,
  ResolverWorkspace,
} from '../src/contract';

export class BrokenChain implements Resolver {
  readonly id: string;
  readonly precision = 'syntactic';
  readonly capabilities: ResolverCapabilities = {
    extensions: [],
    kinds: [],
    host: 'headless',
    maxConcurrentFiles: 1,
  };

  constructor(private readonly links: readonly Resolver[]) {
    this.id = `broken(${links.map((l) => l.id).join('>')})`;
  }

  async open(workspace: ResolverWorkspace): Promise<void> {
    for (const link of this.links) await link.open(workspace);
  }

  async fileChanged(filePath: WorkspacePath, text: string | null): Promise<void> {
    for (const link of this.links) await link.fileChanged(filePath, text);
  }

  async resolve(
    filePath: WorkspacePath,
    refs: readonly RefSite[],
    ctx?: ResolveContext,
  ): Promise<ResolveBatch> {
    const answers = new Map<string, Resolution>();
    let pending: readonly RefSite[] = refs;
    for (const link of this.links) {
      if (pending.length === 0) break;
      const { resolutions } = await link.resolve(filePath, pending, ctx);
      const byId = new Map(resolutions.map((r) => [r.refId, r]));
      const still: RefSite[] = [];
      for (const site of pending) {
        const result = byId.get(site.id);
        if (result === undefined) {
          still.push(site);
          continue;
        }
        answers.set(site.id, result);
        if (result.status === 'unresolved' || result.status === 'dynamic') still.push(site);
      }
      pending = still;
    }
    const resolutions = refs.map(
      (ref): Resolution =>
        answers.get(ref.id) ?? {
          refId: ref.id,
          status: 'unresolved',
          resolvedBy: this.id,
          confidence: 0,
          reason: 'no-resolver',
        },
    );
    return {
      resolutions,
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
    return { resolverId: this.id, state: 'ready', restarts: 0 };
  }

  async close(): Promise<void> {
    for (const link of this.links) await link.close();
  }
}
