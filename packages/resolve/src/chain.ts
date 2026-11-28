// SEAT (U6c.1a): ChainResolver, ported from archive 21754b4:packages/cpg-generator/src/chain.ts with
// C-RESOLVE's capability parity (INV-4) and no-downgrade (INV-10) added.
import type { WorkspacePath } from '@cpg/model';
import type {
  ResolveBatch,
  ResolveContext,
  RefSite,
  Resolver,
  ResolverCapabilities,
  ResolverStatus,
  ResolverWorkspace,
} from './contract';

/**
 * Tries each link in order, so a precise link can sit in front of a cheap one without the cheap one
 * ever overruling it. Ranks are C-RESOLVE's status_rank (unresolved 0, dynamic 1, external 2,
 * ambiguous 3, resolved 4).
 *
 * Construction:
 * - INV-4, capability parity: for every link whose `capabilities.host` is `host-accelerator` and every
 *   kind in its `capabilities.kinds`, some `headless` link of this chain must declare that kind; else
 *   the constructor throws an Error whose message starts `capability-parity:`.
 * - `id` is `chain(<link ids joined by '>'>)`. `precision` is `checker` if any link's is, else the
 *   first link's, else `syntactic`.
 * - `capabilities`: extensions and kinds are the union of the links' (first-seen order, no repeats);
 *   host is `host-accelerator` if any link's is, else `headless`; maxConcurrentFiles is the links'
 *   minimum (`Infinity` with no links).
 *
 * `resolve(filePath, refs, ctx)`:
 * - Before `open`, or after `close`: rejects `workspace-not-open` (INV-6).
 * - An already-cancelled `ctx.token`: every site `unresolved` / `cancelled` from this chain's id, and
 *   no link is asked (INV-20).
 * - Otherwise each link in order is asked, with the same `ctx`, about the sites still OPEN: those with
 *   no answer yet or whose kept answer has rank <= 1. A site whose kept answer reaches rank >= 2 is
 *   never sent to a later link (INV-9). The loop ends early when no site is open, and before a link
 *   when `ctx.token` is cancelled by then (INV-20: no later link is asked).
 * - A link's answers are matched to sites by `refId`; an answer for a site not sent is ignored, a
 *   site missing from the link's answers stays as it was (it may be sent to the next link), and of
 *   several answers for one site the last counts.
 * - Keeping: a site's answer from this link replaces the kept one when there is none, or when its
 *   rank is greater, or when the ranks are equal (the LAST of equal-rank open answers wins, INV-9).
 *   A lower rank never replaces a kept answer (INV-10, including dynamic -> unresolved).
 * - Result: exactly one Resolution per ref, in ref order (INV-1): the kept answer, else
 *   `unresolved` from this chain's id with reason `cancelled` if the loop stopped on cancellation,
 *   else `no-resolver`.
 * - Diagnostics, over the batches of the links asked: resolverId this chain's id, the file,
 *   siteCount refs.length, degraded if any was, elapsedMs and timedOutSites summed, and backend the
 *   worst under ready < warming < starting < stopped < degraded (`ready` when no link was asked).
 *
 * `open`, `fileChanged` and `close` call every link in order, each awaited before the next.
 * `status()`: this chain's id; state the worst of the links' states under the same order (`ready`
 * with no links); restarts summed; lastError the first link's that has one.
 */
export class ChainResolver implements Resolver {
  readonly id: string;
  readonly precision: Resolver['precision'];
  readonly capabilities: ResolverCapabilities;

  constructor(_links: readonly Resolver[]) {
    throw new Error('SEAT: ChainResolver lands in U6c.1a');
  }

  open(_workspace: ResolverWorkspace): Promise<void> {
    throw new Error('SEAT: ChainResolver lands in U6c.1a');
  }

  fileChanged(_filePath: WorkspacePath, _text: string | null): Promise<void> {
    throw new Error('SEAT: ChainResolver lands in U6c.1a');
  }

  resolve(
    _filePath: WorkspacePath,
    _refs: readonly RefSite[],
    _ctx?: ResolveContext,
  ): Promise<ResolveBatch> {
    throw new Error('SEAT: ChainResolver lands in U6c.1a');
  }

  status(): ResolverStatus {
    throw new Error('SEAT: ChainResolver lands in U6c.1a');
  }

  close(): Promise<void> {
    throw new Error('SEAT: ChainResolver lands in U6c.1a');
  }
}
