import { unresolved, type CancellationLike, type Resolution, type RefSite, type Resolver, type ResolverWorkspace } from './resolve';

/**
 * PASSTHROUGH — the seam (`resolve.ts`) is wired end to end, from
 * `extension.ts` through `WorkspaceSession` and `parseWorkspace` /
 * `monitorWorkspace` down to `runResolvePass`, and this is what sits on the far
 * end of it today. Every site comes back `unresolved`, so no symbol is minted,
 * no cross-file edge is emitted, and the rendered graph is identical to the one
 * built before any of this existed.
 *
 * Landing it before any resolution logic is the point: swapping in the real
 * resolver becomes a one-line change at the single construction site in
 * `extension.ts` — a body swap, not a re-wiring — and until then the reference
 * counts it reports prove the pass is genuinely running rather than merely
 * present.
 *
 * It is a `PASSTHROUGH` and not a `SEAT` because it stays useful afterwards, in
 * two ways: it is the honest fallback for a workspace whose language has no
 * server installed and no syntactic rules written, and it is the "nothing
 * resolves" control the verification harness diffs against to prove a change
 * added only what it claimed to.
 */
export class NullResolver implements Resolver {
	readonly id = 'null';
	readonly precision = 'syntactic' as const;

	async open(_workspace: ResolverWorkspace): Promise<void> {}

	async fileChanged(_filePath: string, _text: string | null): Promise<void> {}

	async resolve(_filePath: string, refs: readonly RefSite[], _token?: CancellationLike): Promise<Resolution[]> {
		return refs.map((ref) => unresolved(ref, this.id, 'no-resolver'));
	}

	async close(): Promise<void> {}
}
