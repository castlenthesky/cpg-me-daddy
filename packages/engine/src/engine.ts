// createEngine: the engine's one constructor. Only a front door (apps/*) calls it (03-architecture §2
// rule 3, check-deps rule engine-call-site); this package defines it and never calls it.

import { realpath } from 'node:fs/promises';
import {
  CPG_SCHEMA,
  isWorkspacePath,
  WORKSPACE_ROOT,
  type GraphPayload,
  type SchemaDocInput,
  type WorkspacePath,
} from '@cpg/model';
import type { Extractor } from '@cpg/extract';
import {
  BUILTIN_LANGUAGES,
  createLanguageRegistry,
  type ParseService,
  type ParseServiceOptions,
} from '@cpg/parse';
import type { ProcessHost, Resolver } from '@cpg/resolve';
import { createMemoryStore, type GraphSink, type MemoryStore } from '@cpg/sink';
import type { EdgeRow, GraphStore, NodeRow, WriteOp, WriteReceipt } from '@cpg/store';
import { createParcelWatchBackend, type TimerApi, type WatchBackend } from '@cpg/watch';
import { createNullGraphStore } from './null-graph-store';
import type {
  ConsumerSwitches,
  CpgEngine,
  EngineSession,
  IndexConfig,
  IndexedFile,
  IndexProgress,
  IndexReport,
  IndexRequest,
  IndexWalk,
  StoreTarget,
  VerifyConfig,
  VerifyReport,
  WatchEvent,
  WatchRequest,
} from './port';
import { verifyStore } from './verify';
import { filesystemTier, type FilesystemTier } from './walker/filesystem-tier';
import { walkWorkspace, type WalkResult } from './walker/walker';
import { runWatch, type IndexRun } from './watch';

export interface EngineConfig {
  /** identity.version: the front door's manifest version, never a literal (C-CLI I-13). */
  readonly version: string;
  /** The resolved switches: the engine builds only the sinks they enable (owner decision 5). */
  readonly consumers: ConsumerSwitches;
  /**
   * The grammar directory the front door chose, absolute (controller decision 100; C-PARSE I11's
   * `explicit` rule: the CLI passes CPG_GRAMMAR_DIR resolved against its cwd). Absent: the grammar
   * package's own directory. A directory that does not hold the grammar is a warning, never fatal.
   * SEAT (U6a.3-2 RED): accepted and unused.
   */
  readonly grammarDir?: string;
}

/** A durable store sink: MemoryStore now, FalkorStore at U5. */
export type EngineSink = GraphSink & GraphStore;

export interface EngineDeps {
  /** Host-adapter sinks (e.g. the VS Code panel's, U3), written after the built-in ones. */
  readonly sinks?: readonly EngineSink[];
  /**
   * The instance to use as the built-in memory store; a test plants graphs in it. A MemoryStore,
   * because inspect reads it whole (`readAll`).
   */
  readonly memoryStore?: MemoryStore;
  /** SEAT: accepted and unused until the resolver chain (U6c). */
  readonly resolvers?: readonly Resolver[];
  /** SEAT: accepted and unused until the LSP driver (U8). */
  readonly processHost?: ProcessHost;
  /**
   * The backend `watch` subscribes with. Default: @parcel/watcher (`createParcelWatchBackend`), on
   * `now`, with node's `realpath` so macOS real paths map back onto the root.
   */
  readonly watchBackend?: WatchBackend;
  /**
   * The clock `watch` stamps with: WatchEvent `at`, the session's `clock.settledAt`, the end of a
   * write, and the default backend's `observedAt` (C-CLI I-30). Default `Date.now`, looked up at
   * each call.
   */
  readonly now?: () => number;
  /** The watch session's timers (debounce, retry backoff). Default: the global ones. */
  readonly timers?: TimerApi;
  /**
   * The code tier's extractor; its `grammars` are the languages the code tier runs for (decision
   * 96). Default: `createExtractor()` from @cpg/extract. SEAT (U6a.3-2 RED): accepted and unused.
   */
  readonly extractor?: Extractor;
  /**
   * Builds the engine's one ParseService, on the first file the code tier parses (decision 100).
   * Default: @cpg/parse's `createParseService`. SEAT (U6a.3-2 RED): accepted and unused.
   */
  readonly createParseService?: (options: ParseServiceOptions) => ParseService;
}

/**
 * Turns a walked filesystem tier into ONE `merge-filesystem` WriteOp, carrying `removals` for any
 * stale store paths to drop before upserting (decision 77; empty on dry runs).
 */
function toMergeFilesystemOp(
  tier: FilesystemTier,
  removals: readonly WorkspacePath[] = [],
): WriteOp {
  const directories: NodeRow[] = [];
  const files: NodeRow[] = [];
  const byId = new Map<string, NodeRow>();

  for (const node of tier.nodes) {
    const path = node.data?.['path'];
    if (typeof path !== 'string') continue;
    if (node.type !== 'DIRECTORY' && node.type !== 'FILE') continue;
    const row: NodeRow = { label: node.type, key: path, properties: { ...node.data } };
    if (node.type === 'DIRECTORY') directories.push(row);
    else files.push(row);
    byId.set(node.id, row);
  }

  const links: EdgeRow[] = [];
  for (const edge of tier.edges) {
    if (edge.type !== 'HAS_ENTRY') continue;
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (from === undefined || to === undefined) continue;
    links.push({
      type: 'HAS_ENTRY',
      fromLabel: 'DIRECTORY',
      fromKey: from.key,
      toLabel: to.label,
      toKey: to.key,
      properties: {},
    });
  }

  return { kind: 'merge-filesystem', directories, files, links, moves: [], removals };
}

/**
 * Paths the store still holds as FILE or DIRECTORY nodes that the walk did not find for that label
 * (decision 77, S25-2): never the root `'.'` (C-STORE INV-7), never non-workspace paths, no
 * duplicates. Every other node type is ignored.
 */
function stalePaths(payload: GraphPayload, walk: WalkResult): readonly WorkspacePath[] {
  const walkedFiles = new Set<string>(walk.files.map((file) => file.path));
  const walkedDirs = new Set<string>(walk.directories.map((dir) => dir.path));
  const removals = new Set<WorkspacePath>();
  for (const node of payload.nodes) {
    if (node.type !== 'FILE' && node.type !== 'DIRECTORY') continue;
    const path = node.data?.['path'];
    if (typeof path !== 'string' || path === WORKSPACE_ROOT || !isWorkspacePath(path)) continue;
    if (node.type === 'FILE' ? !walkedFiles.has(path) : !walkedDirs.has(path)) {
      removals.add(path);
    }
  }
  return [...removals];
}

function unbuiltConsumers(consumers: ConsumerSwitches): readonly string[] {
  const parts: string[] = [];
  if (consumers.store === 'falkor') parts.push('consumers.store falkor (FalkorStore, U5)');
  return parts;
}

export function createEngine(config: EngineConfig, deps: EngineDeps = {}): CpgEngine {
  // REAL
  const memory: MemoryStore = deps.memoryStore ?? createMemoryStore({ id: 'memory' });
  const hostSinks: readonly EngineSink[] = deps.sinks ?? [];
  const sinks: readonly EngineSink[] = [memory, ...hostSinks];
  const registry = createLanguageRegistry();
  for (const lang of BUILTIN_LANGUAGES) {
    registry.register(lang);
  }
  registry.freeze();
  const languageOf = (p: string): string | undefined => registry.languageForPath(p);

  async function writeAll(op: WriteOp): Promise<WriteReceipt> {
    // Sequential by design: write each sink in order, never Promise.all.
    const first = await memory.write(op);
    /* oxlint-disable no-await-in-loop */
    for (const sink of hostSinks) {
      await sink.write(op);
    }
    /* oxlint-enable no-await-in-loop */
    return first;
  }

  /**
   * Walks the workspace and writes one `merge-filesystem` op. With a session, reads the built-in
   * memory store first so paths the walk did not find for their label are removed across every sink
   * in that same op (decision 77, S25-2); a dry run (`session === null`) reads nothing and writes
   * with `removals: []` to a NullGraphStore.
   */
  async function runIndex(
    req: IndexRequest,
    onProgress: (progress: IndexProgress) => void,
    signal: AbortSignal,
  ): Promise<IndexRun> {
    if (req.resumeFrom !== null) {
      throw new Error('SEAT: resumeFrom: v1 index is not resumable; pass null');
    }
    const start = performance.now();
    const walkResult = await walkWorkspace({
      root: req.config.root,
      languageOf,
      ...(req.config.include !== undefined ? { include: req.config.include } : {}),
      ...(req.config.exclude !== undefined ? { exclude: req.config.exclude } : {}),
      ...(req.config.maxFileSizeBytes !== undefined
        ? { maxFileSizeBytes: req.config.maxFileSizeBytes }
        : {}),
    });
    onProgress({ phase: 'walked', filesTotal: walkResult.files.length });

    const { stats } = walkResult;
    const walk: IndexWalk = {
      filesSeen: stats.filesSeen,
      filesIndexed: walkResult.files.length - stats.filesUnsupported,
      filesExcluded: stats.filesExcluded,
      filesUnsupported: stats.filesUnsupported,
      filesTooLarge: stats.filesTooLarge,
      filesFailed: stats.filesFailed,
    };

    const warnings: string[] = [
      'the code tier is not built yet (U6a): only the filesystem tier was indexed',
    ];
    if (walk.filesIndexed === 0) {
      warnings.push(`no files indexed under ${req.config.root}`);
    }

    if (signal.aborted) {
      return {
        report: {
          root: req.config.root,
          walk,
          files: [],
          nodesWritten: 0,
          edgesWritten: 0,
          durationMs: performance.now() - start,
          dryRun: req.session === null,
          interrupted: true,
          warnings,
          // SEAT: FalkorStore (U5) will report the target it dialled; the memory store dials none.
          target: null,
          consumers: [],
        },
        walk: walkResult,
      };
    }

    const tier = filesystemTier(walkResult);

    let nodesWritten = 0;
    let edgesWritten = 0;
    if (req.session === null) {
      const op = toMergeFilesystemOp(tier);
      const nullStore = createNullGraphStore();
      await nullStore.open();
      try {
        const receipt = await nullStore.write(op);
        nodesWritten = receipt.nodesWritten;
        edgesWritten = receipt.edgesWritten;
      } finally {
        await nullStore.close();
      }
    } else {
      const removals = stalePaths(await memory.readAll(), walkResult);
      const op = toMergeFilesystemOp(tier, removals);
      const receipt = await writeAll(op);
      nodesWritten = receipt.nodesWritten;
      edgesWritten = receipt.edgesWritten;
    }

    onProgress({ phase: 'written', filesTotal: walkResult.files.length });

    const files: IndexedFile[] = walkResult.files
      .filter((f) => f.language !== null)
      .map((f) => ({ path: f.path, revision_id: f.revision_id, nodes: 0, edges: 0 }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return {
      report: {
        root: req.config.root,
        walk,
        files,
        nodesWritten,
        edgesWritten,
        durationMs: performance.now() - start,
        dryRun: req.session === null,
        interrupted: false,
        warnings,
        // SEAT: FalkorStore (U5) will report the target it dialled; the memory store dials none.
        target: null,
        consumers: req.session === null ? [] : sinks.map((s) => s.id),
      },
      walk: walkResult,
    };
  }

  return {
    identity: {
      name: '@cpg/engine',
      version: config.version,
      languages: registry.ids(),
    },

    async connect(
      target: StoreTarget,
      _opts: { readonly readOnly: boolean },
    ): Promise<EngineSession> {
      const unbuilt = unbuiltConsumers(config.consumers);
      if (unbuilt.length > 0) {
        throw new Error(`SEAT: not built yet: ${unbuilt.join('; ')}`);
      }
      // SEAT: FalkorStore at U5 — does not dial target.
      /* oxlint-disable no-await-in-loop */
      for (const sink of sinks) {
        await sink.open();
      }
      /* oxlint-enable no-await-in-loop */
      return {
        target,
        async close(): Promise<void> {
          /* oxlint-disable no-await-in-loop */
          for (const sink of sinks) {
            await sink.close();
          }
          /* oxlint-enable no-await-in-loop */
        },
      };
    },

    async index(
      req: IndexRequest,
      onProgress: (progress: IndexProgress) => void,
      signal: AbortSignal,
    ): Promise<IndexReport> {
      return (await runIndex(req, onProgress, signal)).report;
    },

    watch(
      req: WatchRequest,
      onEvent: (event: WatchEvent) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const readNow = (): number => (deps.now ?? Date.now)();
      const backend = deps.watchBackend ?? createParcelWatchBackend({ now: readNow, realpath });
      return runWatch(
        {
          runIndex,
          write: writeAll,
          languageOf,
          backend,
          now: readNow,
          ...(deps.timers !== undefined ? { timers: deps.timers } : {}),
        },
        req,
        onEvent,
        signal,
      );
    },

    async verify(
      _session: EngineSession,
      verifyConfig: VerifyConfig,
      expected: IndexReport | null,
    ): Promise<VerifyReport> {
      // REAL; SEAT: _session is unused because dialling a target is U5 — every session reaches
      // the built-in memory store.
      if (expected !== null) {
        throw new Error(
          'SEAT: verify against an expected IndexReport lands with its first caller (C-CLI Q9)',
        );
      }
      return verifyStore(memory, verifyConfig, languageOf);
    },

    async inspect(_session: EngineSession, _config: IndexConfig): Promise<GraphPayload> {
      // REAL; SEAT: _session is unused until a store dials a target (U5) — every session reaches
      // the built-in memory store.
      return memory.readAll();
    },

    schema(): SchemaDocInput {
      // REAL
      return CPG_SCHEMA;
    },
  };
}
