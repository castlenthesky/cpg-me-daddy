import { unresolved, type CancellationLike, type RefSite, type Resolution, type Resolver, type ResolverWorkspace } from './resolve';

/**
 * Tries each resolver in order and keeps the first real answer, so a
 * high-precision resolver can be put in front of a cheap one without the cheap
 * one ever being able to *overrule* it.
 *
 * The composition rule: `resolved`, `ambiguous` and `external` are **answers**
 * and stop the chain for that site; `unresolved` and `dynamic` fall through to
 * the next, weaker link. A site that every link declines keeps the *last*
 * reason given, so the output still says why rather than collapsing to a
 * generic failure.
 *
 * This ordering is what makes the language-server-plus-filesystem pair safe.
 * The type checker is more precise wherever it is configured correctly, but it
 * answers nothing at all for a workspace it cannot resolve imports in — for
 * instance a flat `src/` layout with no `extraPaths`, which is exactly the demo
 * workspace. Putting a filesystem probe behind it means such a workspace still
 * gets edges, and a correctly-configured one still gets the checker's answers.
 */
export class ChainResolver implements Resolver {
	readonly id: string;
	readonly precision: 'syntactic' | 'checker' | 'index';

	constructor(private readonly links: readonly Resolver[]) {
		this.id = `chain(${links.map((link) => link.id).join('>')})`;
		// The chain is as precise as its best link, since that link answers first.
		this.precision = links.some((link) => link.precision === 'checker') ? 'checker' : (links[0]?.precision ?? 'syntactic');
	}

	async open(workspace: ResolverWorkspace): Promise<void> {
		for (const link of this.links) {
			await link.open(workspace);
		}
	}

	async fileChanged(filePath: string, text: string | null): Promise<void> {
		for (const link of this.links) {
			await link.fileChanged(filePath, text);
		}
	}

	async resolve(filePath: string, refs: readonly RefSite[], token?: CancellationLike): Promise<Resolution[]> {
		const answers = new Map<string, Resolution>();
		let pending: readonly RefSite[] = refs;

		for (const link of this.links) {
			if (pending.length === 0) {
				break;
			}
			const results = await link.resolve(filePath, pending, token);
			const byId = new Map(results.map((result) => [result.refId, result]));
			const stillPending: RefSite[] = [];
			for (const site of pending) {
				const result = byId.get(site.id);
				if (!result) {
					// A link that dropped an entry is violating the contract; treat
					// it as "no answer" rather than losing the site entirely.
					stillPending.push(site);
					continue;
				}
				// Recorded either way, so an exhausted chain still reports the
				// most recent reason instead of a generic failure.
				answers.set(site.id, result);
				if (result.status === 'unresolved' || result.status === 'dynamic') {
					stillPending.push(site);
				}
			}
			pending = stillPending;
		}

		return refs.map((ref) => answers.get(ref.id) ?? unresolved(ref, this.id, 'no-resolver'));
	}

	async close(): Promise<void> {
		for (const link of this.links) {
			await link.close();
		}
	}
}
