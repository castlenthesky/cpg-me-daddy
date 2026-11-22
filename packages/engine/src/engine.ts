// createEngine: the engine's one constructor. Only a front door (apps/*) calls it (03-architecture §2
// rule 3, check-deps rule engine-call-site); this package defines it and never calls it.

import { BUILTIN_LANGUAGES, createLanguageRegistry } from '@cpg/parse';
import type { ProcessHost, Resolver } from '@cpg/resolve';
import type { GraphSink } from '@cpg/sink';
import type { EdgeRow, GraphStore, NodeRow, WriteOp } from '@cpg/store';
import { createNullGraphStore } from './null-graph-store';
import type {
  CpgEngine,
  EngineSession,
  IndexedFile,
  IndexProgress,
  IndexReport,
  IndexRequest,
  IndexWalk,
  StoreTarget,
  VerifyConfig,
  VerifyReport,
} from './port';
import { verifyStore } from './verify';
import { filesystemTier, type FilesystemTier } from './walker/filesystem-tier';
import { walkWorkspace } from './walker/walker';

export interface EngineConfig {
  /** identity.version: the front door's manifest version, never a literal (C-CLI I-13). */
  readonly version: string;
}

/** A durable store sink: MemoryStore now, FalkorStore at U5. */
export type EngineSink = GraphSink & GraphStore;

export interface EngineDeps {
  readonly sinks: readonly EngineSink[];
  /** SEAT: accepted and unused until the resolver chain (U6c). */
  readonly resolvers?: readonly Resolver[];
  /** SEAT: accepted and unused until the LSP driver (U8). */
  readonly processHost?: ProcessHost;
}

function toMergeFilesystemOp(tier: FilesystemTier): WriteOp {
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

  return { kind: 'merge-filesystem', directories, files, links, moves: [], removals: [] };
}

export function createEngine(config: EngineConfig, deps: EngineDeps): CpgEngine {
  // REAL
  const registry = createLanguageRegistry();
  for (const lang of BUILTIN_LANGUAGES) {
    registry.register(lang);
  }
  registry.freeze();
  const languageOf = (p: string): string | undefined => registry.languageForPath(p);

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
      // SEAT: FalkorStore at U5 — does not dial target.
      /* oxlint-disable no-await-in-loop */
      for (const sink of deps.sinks) {
        await sink.open();
      }
      /* oxlint-enable no-await-in-loop */
      return {
        target,
        async close(): Promise<void> {
          /* oxlint-disable no-await-in-loop */
          for (const sink of deps.sinks) {
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
          root: req.config.root,
          walk,
          files: [],
          nodesWritten: 0,
          edgesWritten: 0,
          durationMs: performance.now() - start,
          dryRun: req.session === null,
          interrupted: true,
          warnings,
          target: req.session?.target ?? null,
          consumers: [],
        };
      }

      const op = toMergeFilesystemOp(filesystemTier(walkResult));

      let nodesWritten = 0;
      let edgesWritten = 0;
      if (req.session === null) {
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
        let first = true;
        // Sequential by design: write each sink in order, never Promise.all.
        /* oxlint-disable no-await-in-loop */
        for (const sink of deps.sinks) {
          const receipt = await sink.write(op);
          if (first) {
            nodesWritten = receipt.nodesWritten;
            edgesWritten = receipt.edgesWritten;
            first = false;
          }
        }
        /* oxlint-enable no-await-in-loop */
      }

      onProgress({ phase: 'written', filesTotal: walkResult.files.length });

      const files: IndexedFile[] = walkResult.files
        .filter((f) => f.language !== null)
        .map((f) => ({ path: f.path, revision_id: f.revision_id, nodes: 0, edges: 0 }))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      return {
        root: req.config.root,
        walk,
        files,
        nodesWritten,
        edgesWritten,
        durationMs: performance.now() - start,
        dryRun: req.session === null,
        interrupted: false,
        warnings,
        target: req.session?.target ?? null,
        consumers: req.session === null ? [] : deps.sinks.map((s) => s.id),
      };
    },

    async verify(
      _session: EngineSession,
      verifyConfig: VerifyConfig,
      expected: IndexReport | null,
    ): Promise<VerifyReport> {
      // REAL; SEAT: _session is unused because dialling a target is U5 — every session reaches
      // deps.sinks.
      if (expected !== null) {
        throw new Error(
          'SEAT: verify against an expected IndexReport lands with its first caller (C-CLI Q9)',
        );
      }
      if (deps.sinks.length > 1) {
        throw new Error('SEAT: verify over more than one store lands with FalkorStore (U5)');
      }
      return verifyStore(deps.sinks[0], verifyConfig, languageOf);
    },
  };
}
