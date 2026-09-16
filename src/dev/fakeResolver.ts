import { join } from 'node:path';
import { unresolved, type CancellationLike, type DefinitionSite, type RefKind, type RefSite, type Resolution, type Resolver, type ResolverWorkspace } from '@cpg/cpg-generator';

/**
 * Where a fixture says one reference points, in workspace-relative terms so a
 * table is readable and portable.
 *
 * `kind` is part of the key, not just metadata: a `receiver` and a
 * `receiver-type` site sit at the *same* position (the receiver's own
 * token) — `definition` vs `typeDefinition` asked at one place — so keying
 * only on position would let one silently overwrite the other.
 */
export interface FixtureDefinition {
	/** Which `RefSite.kind` this row answers. Defaults to `'call'` when omitted, so existing call-only tables don't need updating. */
	kind?: RefKind;
	/** Workspace-relative POSIX path of the referencing file. */
	from: string;
	row: number;
	column: number;
	/** Workspace-relative POSIX path of the defining file. */
	toFile: string;
	toRow: number;
	toColumn: number;
}

export interface FixtureResolverOptions {
	/** Resolve nothing and report this reason instead — the "nothing answers" control. */
	resolveNothing?: boolean;
	/** Delay each batch, to provoke out-of-order completion without a language server. */
	latencyMs?: number;
}

/**
 * A `Resolver` backed by a hand-written table instead of a language server.
 *
 * This is the piece that makes the identity logic testable off VS Code: it
 * answers with definition *locations*, exactly as the real resolver will, so
 * everything downstream — mapping a location to the node that owns it, reading
 * that node's fqn, minting a symbol, reference-counting it across a re-parse —
 * runs for real against a known-correct input. A fixture also lets a case be
 * set up that the real resolver cannot currently produce, which is how the
 * cross-file link gets checked before any of the resolution rules exist.
 *
 * Unlisted sites come back `unresolved`, matching the real contract that every
 * site gets an answer in order.
 */
export class FixtureResolver implements Resolver {
	readonly id = 'fixture';
	readonly precision = 'index' as const;

	private rootPath = '';
	private readonly byKey = new Map<string, DefinitionSite>();

	constructor(
		private readonly definitions: readonly FixtureDefinition[],
		private readonly options: FixtureResolverOptions = {}
	) {}

	async open(workspace: ResolverWorkspace): Promise<void> {
		this.rootPath = workspace.rootPath;
		this.byKey.clear();
		for (const definition of this.definitions) {
			const key = siteKey(join(this.rootPath, definition.from), definition.row, definition.column, definition.kind ?? 'call');
			this.byKey.set(key, {
				filePath: join(this.rootPath, definition.toFile),
				position: { row: definition.toRow, column: definition.toColumn },
			});
		}
	}

	async fileChanged(_filePath: string, _text: string | null): Promise<void> {}

	async resolve(_filePath: string, refs: readonly RefSite[], _token?: CancellationLike): Promise<Resolution[]> {
		if (this.options.latencyMs) {
			await new Promise<void>((resolve) => setTimeout(resolve, this.options.latencyMs));
		}
		return refs.map((ref) => {
			if (this.options.resolveNothing) {
				return unresolved(ref, this.id, 'no-definition');
			}
			const definition = this.byKey.get(siteKey(ref.filePath, ref.position.row, ref.position.column, ref.kind));
			if (!definition) {
				return unresolved(ref, this.id, 'no-definition');
			}
			return { refId: ref.id, status: 'resolved' as const, definition, resolvedBy: this.id, confidence: 1 };
		});
	}

	async close(): Promise<void> {}

	/** Which fixture entries were never matched by a real reference site — a table that has drifted from the source is worse than no table. */
	unmatched(matchedKeys: ReadonlySet<string>): FixtureDefinition[] {
		return this.definitions.filter(
			(definition) => !matchedKeys.has(siteKey(join(this.rootPath, definition.from), definition.row, definition.column, definition.kind ?? 'call'))
		);
	}
}

export function siteKey(filePath: string, row: number, column: number, kind: RefKind): string {
	return `${filePath}:${row}:${column}:${kind}`;
}
