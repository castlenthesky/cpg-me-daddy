import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import ignore from 'ignore';
// Type-only, and from the deep 'dist/contract' path rather than the package
// barrel: erased at compile time either way, but importing the barrel here
// would make this package's own emitted .d.ts re-export GraphPayload from
// it — forcing any consumer (e.g. the extension host, which has no "dom" lib)
// to resolve the whole barrel, including its DOM-typed GraphVisualizer
// export, just to see this function's return type. contract.ts has no
// dependencies of its own, so this never pulls in graph-visualizer's
// browser/DOM code (or its @cosmos.gl/graph dependency) either way.
import type { GraphDelta, GraphPayload } from '@cpg/graph-visualizer/dist/contract';

// The package barrel also re-exports the MonitorWorkspace-phase pieces —
// same public entry point (`@cpg/file-watcher`) as before, now backing both
// named phases from the project plan rather than one 388-line module.
export * from './changes';
export * from './monitor';
export * from './queue';
export { ChangeBatcher, type ChangeBatcherOptions } from './debounce';

type IgnoreMatcher = ReturnType<typeof ignore>;

export interface FileTreeNode {
	name: string;
	path: string;
	type: 'file' | 'directory';
	children?: FileTreeNode[];
}

// Directory names skipped at any depth regardless of .gitignore — the noise
// nearly every ecosystem produces (VCS internals, installed dependencies or
// virtualenvs, bytecode/test caches, build output). `.gitignore` (loaded via
// loadGitignore below) is the general mechanism the traversal defers to for
// everything else; this baseline still applies when a workspace has no
// .gitignore at all, or its .gitignore doesn't happen to list one of these.
const DEFAULT_IGNORED_DIRECTORIES = new Set([
	'.git',
	'node_modules',
	'.venv',
	'venv',
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'dist',
	'out',
	'build',
	'.vscode-test',
]);

/**
 * Loads `<rootPath>/.gitignore` into an `ignore` matcher for `walkWorkspace`
 * and `createIgnoreFilter` (below) to share. Only the workspace root's
 * `.gitignore` is read — a nested `.gitignore` inside a subdirectory (e.g. a monorepo
 * package with its own extra ignore rules) is not merged in; see this
 * package's AGENTS.md "Gotchas". A missing or unreadable `.gitignore` yields
 * a matcher that ignores nothing, so callers can use the result
 * unconditionally.
 */
function loadGitignore(rootPath: string): IgnoreMatcher {
	const ig = ignore();
	try {
		ig.add(readFileSync(join(rootPath, '.gitignore'), 'utf8'));
	} catch {
		// No .gitignore (or unreadable) at the workspace root — nothing
		// further to ignore beyond DEFAULT_IGNORED_DIRECTORIES above.
	}
	return ig;
}

/** `ignore` expects POSIX-style paths relative to its root, even on Windows. */
function toIgnorePath(rootPath: string, entryPath: string): string {
	return relative(rootPath, entryPath).split(sep).join('/');
}

/**
 * Synchronously walks `rootPath` into a JSON-serializable tree. This is the
 * one-shot counterpart to `monitorWorkspace`'s ongoing change events — the
 * initial snapshot a caller renders before (and independently of) any
 * live updates. Skips `DEFAULT_IGNORED_DIRECTORIES` by name and anything the
 * workspace's root `.gitignore` matches (see `loadGitignore`), so only the
 * workspace's actual source — the core app and any monorepo packages — ends
 * up in the tree.
 */
export function walkWorkspace(rootPath: string): FileTreeNode {
	return walkDirectory(rootPath, basename(rootPath), rootPath, loadGitignore(rootPath));
}

function walkDirectory(dirPath: string, name: string, rootPath: string, ig: IgnoreMatcher): FileTreeNode {
	// A single unreadable subdirectory (permissions, a broken symlink target,
	// a platform-specific special dir) must not abort the whole walk — it
	// becomes a childless leaf instead of throwing past the caller.
	let entries: Dirent[];
	try {
		entries = readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return { name, path: dirPath, type: 'directory', children: [] };
	}

	const children = entries
		.filter((entry) => !isIgnoredEntry(entry, dirPath, rootPath, ig))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry): FileTreeNode => {
			const entryPath = join(dirPath, entry.name);
			return entry.isDirectory()
				? walkDirectory(entryPath, entry.name, rootPath, ig)
				: { name: entry.name, path: entryPath, type: 'file' };
		});

	return { name, path: dirPath, type: 'directory', children };
}

function isIgnoredEntry(entry: Dirent, dirPath: string, rootPath: string, ig: IgnoreMatcher): boolean {
	if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
		return true;
	}
	const ignorePath = toIgnorePath(rootPath, join(dirPath, entry.name));
	// A trailing slash is how `ignore` tells a directory-only pattern (e.g.
	// `build/`) apart from a same-named file — see the `ignore` package's
	// own README ("Pathname Conventions").
	return ig.ignores(entry.isDirectory() ? `${ignorePath}/` : ignorePath);
}

/**
 * Flattens a `FileTreeNode` into the generic `{ nodes, edges }` shape
 * `@cpg/graph-visualizer` renders — one node per file/directory (id = path)
 * and one `'CONTAINS'` edge per parent → child, so directory nesting seeds
 * the visualizer's radial layout exactly as it did when it walked
 * `children` directly.
 */
export function toGraphPayload(tree: FileTreeNode): GraphPayload {
	const nodes: GraphPayload['nodes'] = [];
	const edges: GraphPayload['edges'] = [];

	function visit(node: FileTreeNode): void {
		nodes.push({ id: node.path, type: node.type, name: node.name });
		for (const child of node.children ?? []) {
			edges.push({ source: node.path, target: child.path, type: 'CONTAINS' });
			visit(child);
		}
	}
	visit(tree);

	return { nodes, edges };
}

/**
 * Owns the graph's file/directory state — the thing `monitorWorkspace`
 * (`monitor.ts`) mutates on every `WorkspaceChange` and what
 * `parseWorkspace` builds fresh on every ParseWorkspace run. Seeded from a
 * `walkWorkspace` snapshot; `applyChange` turns an absolute changed path
 * (creation or deletion — the caller doesn't need to say which) into the
 * minimal `GraphDelta` needed to bring a previously-rendered graph up to
 * date.
 *
 * A watcher only says *something* changed at a path, not what — so every
 * change rescans the nearest indexed ancestor *directory* (walking up if the
 * changed path itself, or an intermediate directory, isn't indexed yet —
 * e.g. a deeply-nested path created inside a directory that was itself just
 * created in the same burst of events) and diffs its current disk listing
 * against the cached one. This is also what makes replaying an
 * already-applied event free: `applyChange` diffs against disk, so it
 * naturally returns `undefined` for a path that's already reflected in the
 * index, which is what lets `UpdateQueue` (`queue.ts`) safely over-deliver
 * rather than needing to reason about exactly which events overlapped a
 * parse. A plain content edit to an existing file also yields no delta at
 * all — presence, not content, is all this index tracks.
 */
export class WorkspaceGraphIndex {
	private readonly ig: IgnoreMatcher;
	private readonly nodesByPath = new Map<string, FileTreeNode>();
	private readonly childPathsByParent = new Map<string, string[]>();

	constructor(private readonly rootPath: string, tree: FileTreeNode) {
		this.ig = loadGitignore(rootPath);
		this.index(tree);
	}

	private index(node: FileTreeNode): void {
		this.nodesByPath.set(node.path, node);
		if (node.children) {
			this.childPathsByParent.set(
				node.path,
				node.children.map((child) => child.path)
			);
			for (const child of node.children) {
				this.index(child);
			}
		}
	}

	applyChange(changedAbsPath: string): GraphDelta | undefined {
		const dirPath = this.findIndexedAncestorDir(changedAbsPath);
		if (!dirPath) {
			return undefined;
		}
		const delta: GraphDelta = { addedNodes: [], addedEdges: [], removedNodeIds: [] };
		this.rescanDirectory(dirPath, delta);
		return delta.addedNodes.length === 0 && delta.removedNodeIds.length === 0 ? undefined : delta;
	}

	/**
	 * SEAT — a placeholder for the project plan's migration 5 (move-aware
	 * `GraphDelta`s). A rename within the same directory should become an
	 * in-place re-key that keeps the node's rendered position; today every
	 * move, same-directory or not, falls back to a delete-at-the-old-path
	 * plus create-at-the-new-path merge of two `applyChange` calls — correct
	 * (each rescans and diffs its own parent directory from disk, so this is
	 * safe even for a directory move with descendants), just not
	 * position-preserving. `monitorWorkspace` calls this for every `'moved'`
	 * `WorkspaceChange` (see `monitor.ts`), so this is where migration 5's
	 * real re-key logic plugs in without any caller changing.
	 */
	applyMove(fromAbsPath: string, toAbsPath: string): GraphDelta | undefined {
		const removed = this.applyChange(fromAbsPath);
		const added = this.applyChange(toAbsPath);
		if (!removed && !added) {
			return undefined;
		}
		return {
			addedNodes: [...(removed?.addedNodes ?? []), ...(added?.addedNodes ?? [])],
			addedEdges: [...(removed?.addedEdges ?? []), ...(added?.addedEdges ?? [])],
			removedNodeIds: [...(removed?.removedNodeIds ?? []), ...(added?.removedNodeIds ?? [])],
		};
	}

	private findIndexedAncestorDir(path: string): string | undefined {
		let dir = dirname(path);
		for (;;) {
			if (this.nodesByPath.get(dir)?.type === 'directory') {
				return dir;
			}
			const parent = dirname(dir);
			if (parent === dir) {
				// Reached the filesystem root without finding an indexed
				// directory — rootPath itself must not be indexed (e.g. it was
				// removed out from under us), nothing to rescan.
				return this.nodesByPath.get(this.rootPath) ? this.rootPath : undefined;
			}
			dir = parent;
		}
	}

	private rescanDirectory(dirPath: string, delta: GraphDelta): void {
		if (!this.nodesByPath.has(dirPath)) {
			return;
		}

		// An unreadable/vanished directory rescans as empty — every previously
		// cached child then reads as removed below, same as `walkDirectory`
		// treating an unreadable directory as a childless leaf.
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(dirPath, { withFileTypes: true });
		} catch {
			// handled by the empty `entries` default above
		}

		const current = new Map<string, Dirent>();
		for (const entry of entries) {
			if (!isIgnoredEntry(entry, dirPath, this.rootPath, this.ig)) {
				current.set(entry.name, entry);
			}
		}

		const previousChildren = this.childPathsByParent.get(dirPath) ?? [];
		const keep: string[] = [];
		for (const childPath of previousChildren) {
			if (current.has(basename(childPath))) {
				keep.push(childPath);
			} else {
				this.removeSubtree(childPath, delta);
			}
		}

		const previousNames = new Set(keep.map((path) => basename(path)));
		const addedNames = [...current.keys()].filter((name) => !previousNames.has(name)).sort((a, b) => a.localeCompare(b));
		for (const name of addedNames) {
			const entry = current.get(name)!;
			const entryPath = join(dirPath, name);
			const node: FileTreeNode = entry.isDirectory()
				? walkDirectory(entryPath, name, this.rootPath, this.ig)
				: { name, path: entryPath, type: 'file' };
			this.addSubtree(node, dirPath, delta);
			keep.push(entryPath);
		}

		this.childPathsByParent.set(dirPath, keep);
	}

	private addSubtree(node: FileTreeNode, parentPath: string, delta: GraphDelta): void {
		this.nodesByPath.set(node.path, node);
		delta.addedNodes.push({ id: node.path, type: node.type, name: node.name });
		delta.addedEdges.push({ source: parentPath, target: node.path, type: 'CONTAINS' });
		if (node.children) {
			this.childPathsByParent.set(
				node.path,
				node.children.map((child) => child.path)
			);
			for (const child of node.children) {
				this.addSubtree(child, node.path, delta);
			}
		}
	}

	private removeSubtree(path: string, delta: GraphDelta): void {
		const node = this.nodesByPath.get(path);
		if (!node) {
			return;
		}
		delta.removedNodeIds.push(path);
		this.nodesByPath.delete(path);
		const children = this.childPathsByParent.get(path);
		if (children) {
			this.childPathsByParent.delete(path);
			for (const child of children) {
				this.removeSubtree(child, delta);
			}
		}
	}
}

// A watcher event's path is a bare relative path, not a Dirent — normalize
// to the POSIX form `ignore` expects. Unlike isIgnoredEntry above, whether
// the path names a file or a directory is unknowable here (by the time an
// event fires, the path may already be gone), so a directory-only
// `.gitignore` pattern (e.g. `build/`) can't be distinguished from a
// same-named file — a minor gap noted in AGENTS.md "Gotchas".
// DEFAULT_IGNORED_DIRECTORIES names are unaffected: matched by path segment,
// not by that trailing-slash convention.
function isIgnoredChange(filename: string, ig: IgnoreMatcher): boolean {
	const posixPath = filename.split(sep).join('/');
	if (posixPath.split('/').some((segment) => DEFAULT_IGNORED_DIRECTORIES.has(segment))) {
		return true;
	}
	return ig.ignores(posixPath);
}

/**
 * A `WatchBackend` reports paths, not `.gitignore` status, so this
 * filtering has to live on the monitor side of the watcher seam, same as it
 * did for the old raw fs.watch path — `monitor.ts` calls this once per
 * `monitorWorkspace` subscription. Returns a plain function rather than
 * exposing `loadGitignore`/`isIgnoredChange`/`IgnoreMatcher` directly: those
 * stay private so the `ignore` package's own types (a default export) never
 * appear in this package's public `.d.ts` — the extension host's tsconfig
 * doesn't set `esModuleInterop`, unlike every package tsconfig (which
 * inherits it from tsconfig.base.json), so a leaked reference to a default
 * export's type fails to compile there.
 */
export function createIgnoreFilter(rootPath: string): (relativePath: string) => boolean {
	const ig = loadGitignore(rootPath);
	return (relativePath) => isIgnoredChange(relativePath, ig);
}

export interface ParseWorkspaceResult {
	tree: FileTreeNode;
	payload: GraphPayload;
	index: WorkspaceGraphIndex;
	nodeCount: number;
}

/** Accepted by `parseWorkspace` — the shape of a `vscode.CancellationToken`, without importing `vscode` into this package. */
export interface ParseWorkspaceToken {
	isCancellationRequested: boolean;
}

/**
 * The ParseWorkspace phase's orchestration entry point — see the project
 * plan ("ParseWorkspace / MonitorWorkspace — the eventual structure"). The
 * body is `REAL`: it delegates to today's synchronous `walkWorkspace` and
 * resolves immediately, so this changes no behavior. The signature is
 * already async, with progress and cancellation accepted (both currently
 * ignored — `SEAT`s), so that swapping in a genuinely async, yielding walk
 * later — needed once this also drives a per-file parse — is a body change
 * here, not a change to any caller.
 *
 * `walkWorkspace` keeps its own name and stays a pure traversal — it
 * enumerates files and directories, it doesn't parse anything. This function
 * is the orchestration layer above it: today that's "walk, then build an
 * index and a payload from the result," and eventually also "then parse
 * each file's content," without `parseWorkspace`'s own signature changing.
 */
export async function parseWorkspace(
	rootPath: string,
	onProgress?: (count: number, current: string) => void,
	token?: ParseWorkspaceToken
): Promise<ParseWorkspaceResult> {
	void onProgress;
	void token;
	const tree = walkWorkspace(rootPath);
	const payload = toGraphPayload(tree);
	const index = new WorkspaceGraphIndex(rootPath, tree);
	return { tree, payload, index, nodeCount: payload.nodes.length };
}
