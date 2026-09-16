import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';
import type { CancellationLike, DefinitionLookup, RefSite, Resolution, Resolver, ResolverWorkspace } from '@cpg/cpg-generator';
import { unresolved } from '@cpg/cpg-generator';

/** How many `executeDefinitionProvider` round trips may be in flight at once. `runResolvePass` awaits one file at a time (`resolvePass.ts`), so all parallelism has to live in here — sequential requests don't finish on a real workspace, and unbounded `Promise.all` floods the server into empty answers that look like "not warm yet". */
const MAX_CONCURRENCY = 12;

/** Total time `open()`-adjacent warm-up is allowed to spend probing before giving up and resolving normally. Bounded on purpose: a slow/never-warming language server must not hang ParseWorkspace's first render. */
const WARMUP_BUDGET_MS = 4000;
const WARMUP_RETRY_DELAY_MS = 750;

const PYTHON_EXTENSION_ID = 'ms-python.python';

/**
 * REAL — the only file in the extension host that knows
 * `vscode.commands.executeCommand('vscode.executeDefinitionProvider', …)`
 * exists, exactly as `watch/vscodeWatchBackend.ts` is the only one that knows
 * about the file-watcher API.
 *
 * Symbol identity deliberately does not live here: it returns a *location*
 * (`Resolution.definition`) and lets `resolvePass.ts` turn that into a symbol
 * via `DefinitionLookup.symbolAt`, so swapping this resolver out can never
 * change a symbol id and therefore can never invalidate a cross-file edge
 * another file already points at.
 *
 * What deliberately does **not** go here: any concurrency policy beyond what
 * this class needs to avoid flooding the language server (how many *files*
 * are in flight is the pass's business), and a position cache — nothing calls
 * `fileChanged` with real content today, so a cache would serve pre-edit
 * answers on every save forever.
 */
export class VsCodeDefinitionResolver implements Resolver {
	readonly id = 'vscode-definition';
	readonly precision = 'checker' as const;

	private rootPath = '';
	private realRootPath = '';
	private definitions: DefinitionLookup | undefined;
	private warmedUp = false;

	constructor(private readonly log: (message: string) => void = () => {}) {}

	async open(workspace: ResolverWorkspace): Promise<void> {
		this.rootPath = workspace.rootPath;
		this.realRootPath = realpathQuiet(workspace.rootPath);
		this.definitions = workspace.definitions;

		// Not awaited: activation resolves well before the language server has
		// indexed anything, so it buys nothing to block ParseWorkspace's first
		// render on it. The actual readiness gate is the warm-up probe in
		// `resolve()`, on the first real file.
		void vscode.extensions.getExtension(PYTHON_EXTENSION_ID)?.activate();
	}

	async fileChanged(_filePath: string, _text: string | null): Promise<void> {
		// No cache kept — see the class doc.
	}

	async resolve(filePath: string, refs: readonly RefSite[], token?: CancellationLike): Promise<Resolution[]> {
		if (refs.length === 0) {
			return [];
		}
		if (!filePath.endsWith('.py')) {
			// Scoped to Python for now, matching `PythonPathResolver` — nothing
			// downstream assumes every `Resolver` answers every language.
			return refs.map((ref) => unresolved(ref, this.id, 'no-resolver'));
		}

		const uri = vscode.Uri.file(filePath);
		if (!this.warmedUp) {
			await this.warmUp(uri, refs[0]);
		}

		const answers = new Map<string, Resolution>();
		for (let start = 0; start < refs.length; start += MAX_CONCURRENCY) {
			if (token?.isCancellationRequested) {
				break;
			}
			const batch = refs.slice(start, start + MAX_CONCURRENCY);
			const results = await Promise.all(batch.map((ref) => this.resolveOne(uri, filePath, ref)));
			batch.forEach((ref, index) => answers.set(ref.id, results[index]));
		}

		return refs.map((ref) => answers.get(ref.id) ?? unresolved(ref, this.id, 'not-warm'));
	}

	async close(): Promise<void> {}

	/**
	 * There is no public "is the language server ready" API, so the probe is
	 * behavioral: ask for the definition of the file's own first reference and
	 * treat an empty answer as "not warm yet" rather than "genuinely
	 * unresolvable" — an empty *pre-index* answer and a real miss are
	 * indistinguishable from the outside, so this can only bound how long we
	 * wait, not eliminate the ambiguity. Bounded by `WARMUP_BUDGET_MS` rather
	 * than a fixed retry count, so a fast server proceeds immediately and a
	 * slow one doesn't hang ParseWorkspace forever. Runs once per resolver
	 * instance (one per workspace session).
	 */
	private async warmUp(uri: vscode.Uri, probeRef: RefSite): Promise<void> {
		const deadline = Date.now() + WARMUP_BUDGET_MS;
		for (;;) {
			const locations = await this.rawDefinitions(uri, probeRef.position);
			if (locations.length > 0 || Date.now() >= deadline) {
				if (locations.length === 0) {
					this.log(`${this.id}: language server did not warm up within ${WARMUP_BUDGET_MS}ms; resolving without a warm index`);
				}
				break;
			}
			await delay(WARMUP_RETRY_DELAY_MS);
		}
		this.warmedUp = true;
	}

	private async resolveOne(uri: vscode.Uri, filePath: string, ref: RefSite): Promise<Resolution> {
		let locations: NormalizedLocation[];
		try {
			locations = await this.rawDefinitions(uri, ref.position);
		} catch {
			return { refId: ref.id, status: 'unresolved', resolvedBy: this.id, confidence: 0, reason: 'provider-error' };
		}
		if (locations.length === 0) {
			return unresolved(ref, this.id, 'no-definition');
		}

		// A definition equal to the reference's own position (asking for the
		// definition of a `def`/`class` name returns that same name) would
		// otherwise produce a self-edge.
		const real = locations.filter((location) => !isSamePosition(location, filePath, ref.position));
		if (real.length === 0) {
			return { refId: ref.id, status: 'unresolved', resolvedBy: this.id, confidence: 0, reason: 'self' };
		}

		// Only a location inside a file this workspace actually parsed can back
		// an edge — anything else (a stdlib/typeshed stub, a third-party
		// package) is resolved, just not to something our graph indexed.
		// Falling through as `unresolved` rather than `external` matters: an
		// `external` answer would be final (`ChainResolver` stops on it), which
		// would permanently block `PythonPathResolver`'s own builtin
		// classification for names like `print` that the checker also resolves
		// outside the workspace.
		const indexed = real.filter((location) => this.definitions?.isIndexed(location.filePath) ?? false);
		if (indexed.length === 0) {
			return unresolved(ref, this.id, 'no-definition');
		}

		const distinct = dedupeByPosition(indexed);
		const [first] = distinct;
		if (distinct.length > 1) {
			return {
				refId: ref.id,
				status: 'ambiguous',
				definition: { filePath: first.filePath, position: first.position },
				resolvedBy: this.id,
				confidence: 0.5,
			};
		}
		return {
			refId: ref.id,
			status: 'resolved',
			definition: { filePath: first.filePath, position: first.position },
			resolvedBy: this.id,
			confidence: 1,
		};
	}

	/** The command itself, normalized. Not in `@types/vscode` — it's a plain command string, and the result shape (`Location[] | LocationLink[]`) is provider-dependent, not fixed by the API. */
	private async rawDefinitions(uri: vscode.Uri, position: { row: number; column: number }): Promise<NormalizedLocation[]> {
		const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
			'vscode.executeDefinitionProvider',
			uri,
			new vscode.Position(position.row, position.column)
		);
		return (result ?? []).map((entry) => this.normalize(entry));
	}

	private normalize(entry: vscode.Location | vscode.LocationLink): NormalizedLocation {
		const isLink = 'targetUri' in entry;
		const entryUri = isLink ? entry.targetUri : entry.uri;
		// `targetSelectionRange` is the name token (what we want to line up
		// with `GraphBuilder.symbolAt`'s exact tier); `targetRange` is the
		// whole declaration. A `Location` only ever has the latter.
		const range = isLink ? (entry.targetSelectionRange ?? entry.targetRange) : entry.range;
		return {
			filePath: this.toWorkspacePath(entryUri.fsPath),
			position: { row: range.start.line, column: range.start.character },
		};
	}

	/**
	 * Rewrites a path VS Code reports back into the exact string form the rest
	 * of the pipeline uses, when the two differ only by a symlink in the
	 * workspace root (e.g. macOS `/tmp` vs `/private/tmp`). `symbolAt`/
	 * `isIndexed` key on the literal string `walkWorkspace` produced from
	 * `rootPath`, so a path that resolves to the same file but spells it
	 * differently would otherwise miss silently — `symbolAt` just returns
	 * `undefined` and the pass skips the edge with no error at all.
	 */
	private toWorkspacePath(fsPath: string): string {
		if (fsPath === this.rootPath || fsPath.startsWith(this.rootPath + '/')) {
			return fsPath;
		}
		if (!this.realRootPath) {
			return fsPath;
		}
		const real = realpathQuiet(fsPath);
		if (real === this.realRootPath) {
			return this.rootPath;
		}
		if (real.startsWith(this.realRootPath + '/')) {
			return this.rootPath + real.slice(this.realRootPath.length);
		}
		return fsPath;
	}
}

interface NormalizedLocation {
	filePath: string;
	position: { row: number; column: number };
}

function isSamePosition(location: NormalizedLocation, filePath: string, position: { row: number; column: number }): boolean {
	return location.filePath === filePath && location.position.row === position.row && location.position.column === position.column;
}

function dedupeByPosition(locations: readonly NormalizedLocation[]): NormalizedLocation[] {
	const seen = new Map<string, NormalizedLocation>();
	for (const location of locations) {
		seen.set(`${location.filePath}:${location.position.row}:${location.position.column}`, location);
	}
	return [...seen.values()];
}

function realpathQuiet(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
