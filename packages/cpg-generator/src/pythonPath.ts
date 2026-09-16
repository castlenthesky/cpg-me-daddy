import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { unresolved, type CancellationLike, type DefinitionLookup, type RefSite, type Resolution, type Resolver, type ResolverWorkspace } from './resolve';

/**
 * Python names that are always builtins. Deliberately a short frozen list
 * rather than a complete one: its only job is to keep the overwhelmingly
 * common calls out of the `unresolved` bucket so the unresolved count means
 * something. A builtin resolves as `external`, which mints **no symbol and no
 * edge** — see `runResolvePass` for why a `print` symbol would be actively
 * harmful rather than merely useless.
 */
const PYTHON_BUILTINS = new Set([
	'abs', 'all', 'any', 'bool', 'bytes', 'callable', 'chr', 'dict', 'dir', 'divmod', 'enumerate', 'filter', 'float', 'format', 'frozenset',
	'getattr', 'hasattr', 'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max', 'min', 'next',
	'object', 'oct', 'open', 'ord', 'pow', 'print', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'str', 'sum',
	'super', 'tuple', 'type', 'vars', 'zip',
]);

const PYTHON_EXTENSIONS = ['.py', '.pyi'];

/**
 * Resolves Python references by probing the filesystem and the graph's own
 * definition index — no type checker, no language server, no subprocess.
 *
 * It exists because the precise path has a blind spot that is *common*, not
 * exotic. A type checker resolves `from my_module import x` only if the
 * directory holding `my_module.py` is on its import search path, and nothing
 * puts a bare `src/` there by default: `pyproject.toml`'s `include` says what to
 * *analyze*, not where to *look*. So a flat `src/` layout — the demo workspace,
 * and plenty of real ones — yields no answer at all from the checker, while the
 * first rule below resolves it immediately.
 *
 * Deliberately narrow. It resolves imports, and resolves calls only through
 * this file's own definitions and its own import bindings. A member-access call
 * gets `receiver-unknown` rather than a guess, because a wrong cross-file edge
 * is worse than a missing one: the edge *is* the claim the graph is making.
 */
export class PythonPathResolver implements Resolver {
	readonly id = 'python-path';
	readonly precision = 'syntactic' as const;

	private rootPath = '';
	private definitions: DefinitionLookup | undefined;
	private extraRoots: string[] = [];

	async open(workspace: ResolverWorkspace): Promise<void> {
		this.rootPath = workspace.rootPath;
		this.definitions = workspace.definitions;
		this.extraRoots = readConfiguredRoots(workspace.rootPath);
	}

	async fileChanged(filePath: string, _text: string | null): Promise<void> {
		// Source roots come from pyproject.toml, so only that file can change them.
		if (filePath.endsWith('pyproject.toml')) {
			this.extraRoots = readConfiguredRoots(this.rootPath);
		}
	}

	async resolve(filePath: string, refs: readonly RefSite[], _token?: CancellationLike): Promise<Resolution[]> {
		const definitions = this.definitions;
		if (!definitions || !filePath.endsWith('.py')) {
			return refs.map((ref) => unresolved(ref, this.id, 'no-resolver'));
		}

		const answers = new Map<string, Resolution>();
		// Imports first, because their results *are* the binding table the calls
		// need. Both kinds arrive in one batch for one file, which is what makes
		// this self-contained — no separate index, no second pass over the tree.
		const localBindings = new Map<string, string>();

		for (const ref of refs) {
			if (ref.kind !== 'import') {
				continue;
			}
			const resolution = this.resolveImport(filePath, ref, definitions);
			answers.set(ref.id, resolution);
			const binding = ref.importBinding;
			if (resolution.status === 'resolved' && resolution.target?.fqn && binding) {
				localBindings.set(binding.local, resolution.target.fqn);
			}
		}

		for (const ref of refs) {
			if (ref.kind !== 'call') {
				continue;
			}
			answers.set(ref.id, this.resolveCall(filePath, ref, definitions, localBindings));
		}

		// `receiver`/`receiver-type` sites need the receiver's inferred type,
		// which is exactly the inference this resolver refuses to attempt for a
		// dotted call above — same reasoning, explicit here rather than falling
		// through to the generic `'no-resolver'` below, which would misreport
		// "no resolver answered" for a resolver that looked and declined.
		for (const ref of refs) {
			if (ref.kind === 'receiver' || ref.kind === 'receiver-type') {
				answers.set(ref.id, unresolved(ref, this.id, 'receiver-unknown'));
			}
		}

		return refs.map((ref) => answers.get(ref.id) ?? unresolved(ref, this.id, 'no-resolver'));
	}

	async close(): Promise<void> {}

	private resolveImport(filePath: string, ref: RefSite, definitions: DefinitionLookup): Resolution {
		const binding = ref.importBinding;
		if (!binding) {
			return unresolved(ref, this.id, 'no-definition');
		}
		if (binding.imported === '*') {
			// The bound set isn't enumerable from syntax, so there is no single
			// definition to point at.
			return unresolved(ref, this.id, 'wildcard');
		}
		if (!binding.imported) {
			// `import os` binds the module itself. Reported as `unresolved` with
			// its own reason rather than `dynamic` — nothing here is deferred to
			// runtime; we simply don't model modules as symbols. Mislabelling it
			// would corrupt the one metric that says how much of the graph is
			// genuinely unlinked.
			return unresolved(ref, this.id, 'module-binding');
		}

		const moduleFile = this.findModuleFile(filePath, binding.module, binding.relativeDepth, definitions);
		if (!moduleFile) {
			return unresolved(ref, this.id, 'module-not-found');
		}
		if (!definitions.isIndexed(moduleFile)) {
			// Resolved, but to something outside the graph — a third-party
			// package or a stub. An answer, so the chain stops here.
			return { refId: ref.id, status: 'external', resolvedBy: this.id, confidence: 0.6, reason: 'name-not-exported' };
		}
		const fqn = definitions.symbolNamed(moduleFile, binding.imported);
		if (!fqn) {
			return unresolved(ref, this.id, 'name-not-exported');
		}
		return {
			refId: ref.id,
			status: 'resolved',
			target: { fqn, filePath: moduleFile },
			resolvedBy: this.id,
			confidence: 0.6,
		};
	}

	private resolveCall(filePath: string, ref: RefSite, definitions: DefinitionLookup, localBindings: Map<string, string>): Resolution {
		if (ref.nameParts.length === 0) {
			return unresolved(ref, this.id, 'no-definition');
		}
		if (ref.nameParts.length > 1) {
			// `greeter.greet()` needs the receiver's type, which is real
			// inference this resolver deliberately doesn't attempt. Guessing by
			// the last segment's name would happily link to any same-named
			// method anywhere.
			return unresolved(ref, this.id, 'receiver-unknown');
		}
		const [name] = ref.nameParts;

		const sameFile = definitions.symbolNamed(filePath, name);
		if (sameFile) {
			return { refId: ref.id, status: 'resolved', target: { fqn: sameFile, filePath }, resolvedBy: this.id, confidence: 0.9 };
		}

		const imported = localBindings.get(name);
		if (imported) {
			return { refId: ref.id, status: 'resolved', target: { fqn: imported }, resolvedBy: this.id, confidence: 0.8 };
		}

		if (PYTHON_BUILTINS.has(name)) {
			return { refId: ref.id, status: 'external', resolvedBy: this.id, confidence: 1, reason: 'builtin' };
		}
		return unresolved(ref, this.id, 'no-definition');
	}

	/**
	 * Source roots, probed in order. The **first rule is the one that earns this
	 * whole class**: the directory holding the referencing file. That is what a
	 * flat `src/` layout needs and what a checker rooted at the workspace will
	 * not do.
	 */
	private findModuleFile(refFilePath: string, module: string, relativeDepth: number, definitions: DefinitionLookup): string | undefined {
		if (!module) {
			return undefined;
		}
		const segments = module.split('.');
		const roots =
			relativeDepth >= 1
				? [ascend(dirname(refFilePath), relativeDepth - 1)]
				: [dirname(refFilePath), this.rootPath, join(this.rootPath, 'src'), ...this.extraRoots];

		const candidates: string[] = [];
		for (const root of roots) {
			if (!root) {
				continue;
			}
			for (const extension of PYTHON_EXTENSIONS) {
				candidates.push(join(root, ...segments) + extension);
				candidates.push(join(root, ...segments, `__init__${extension}`));
			}
		}

		// A file already in the graph is both a cache hit and a guarantee there
		// are nodes in it to point at, so prefer one over a merely-existing file.
		return candidates.find((candidate) => definitions.isIndexed(candidate)) ?? candidates.find((candidate) => existsSync(candidate));
	}
}

function ascend(directory: string, levels: number): string {
	let current = directory;
	for (let index = 0; index < levels; index++) {
		current = dirname(current);
	}
	return current;
}

/**
 * Extra source roots from `pyproject.toml`.
 *
 * Read with a regex rather than a TOML parser, deliberately: adding a
 * dependency to read at most three keys is a poor trade, and a miss here is
 * harmless — the sibling-directory and `src/` rules already cover the common
 * layouts, and an unresolvable import is a missing edge, not a wrong one.
 *
 * `include` is read as a last resort even though it is semantically the wrong
 * key (it says what to analyze, not where to look), because it is what a reader
 * of that file would *expect* to work, and honouring it costs nothing.
 */
function readConfiguredRoots(rootPath: string): string[] {
	const manifest = join(rootPath, 'pyproject.toml');
	if (!existsSync(manifest)) {
		return [];
	}
	let contents: string;
	try {
		contents = readFileSync(manifest, 'utf8');
	} catch {
		return [];
	}
	const roots: string[] = [];
	for (const key of ['extraPaths', 'package-dir', 'packages', 'include']) {
		const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(contents);
		if (!match) {
			continue;
		}
		for (const raw of match[1].split(',')) {
			const value = raw.trim().replace(/^["']|["']$/g, '');
			if (!value) {
				continue;
			}
			const absolute = isAbsolute(value) ? value : resolvePath(rootPath, value);
			if (existsSync(absolute) && !roots.includes(absolute)) {
				roots.push(absolute);
			}
		}
	}
	return roots;
}
