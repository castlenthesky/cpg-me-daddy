/**
 * M0.11-lite: orchestrates walk (M0.2) -> parse (F4) -> extractDeclarations
 * (M0.6/M0.8) -> writeDelta (M0.4b), producing a declarations-only graph of
 * a real workspace. Deliberately a one-shot, sequential pipeline — a parse
 * pool / worker pool is M1's; this file's job is to prove the pipeline end
 * to end at real repo scale, not to be fast. `cpg index` and the extension's
 * index command both call this unchanged: everything crossing this
 * function's boundary is plain data or a web-standard `AbortSignal`, never a
 * `vscode` type, so engine purity holds for free.
 *
 * Per-file failures (a file that fails to parse, an adapter that throws) are
 * warnings, not aborts — one bad file must not fail an index of 10,000. A
 * `signal` abort is the one thing that stops the run early, and does so
 * between files, never mid-file.
 */
import { readFile } from "node:fs/promises";

import type { CpgConfig } from "../config/workspace-config";
import type { LanguageAdapter } from "../extract/adapter";
import { extractFile } from "../extract/index";
import { adapterFor as defaultAdapterFor } from "../extract/registry";
import type { SyntaxNode } from "../extract/syntax";
import type { ParserBackend } from "../parser/backend";
import type { GrammarId } from "../parser/grammars";
import { assertGraphDeltaValid, type GraphDelta, type NodeRow } from "../schema/validate";
import type { IGraphStore, WriteReport } from "../store/store";
import { hashBytes } from "../workspace/hash";
import { type WalkStats, walkWorkspace } from "../workspace/walker";

export interface IndexWorkspaceDeps {
  readonly store: IGraphStore;
  readonly backend: ParserBackend<{ rootNode: SyntaxNode }>;
  /** Default: the built-in registry (`adapterFor` from `extract/registry.ts`). Injected in tests. */
  readonly adapterFor?: (id: GrammarId) => LanguageAdapter | undefined;
  /** Injected in tests for a deterministic `FILE.indexed_at`. */
  readonly now?: () => string;
  /** Runs `assertGraphDeltaValid` on every delta before writing it. Default `true`. */
  readonly validate?: boolean;
}

export type IndexPhase = "walk" | "index" | "done";

export interface IndexProgress {
  readonly phase: IndexPhase;
  /** `0` until the walk completes. */
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly currentFile?: string;
  readonly nodesWritten: number;
  readonly edgesWritten: number;
}

export interface IndexWarning {
  readonly kind: "unsupported-grammar" | "parse-failed" | "read-failed" | "write-failed";
  readonly path?: string;
  readonly language?: string;
  readonly message: string;
}

export interface IndexHooks {
  readonly onProgress?: (progress: IndexProgress) => void;
  readonly onWarning?: (warning: IndexWarning) => void;
  readonly signal?: AbortSignal;
  /** Lets a host (the extension) yield its event loop between files. Default: a no-op. */
  readonly yieldBetweenFiles?: () => Promise<void>;
}

export interface IndexReport {
  readonly root: string;
  /** The walk's own counts (candidates seen, excluded, unsupported, too large) — computed once, here. */
  readonly walk: WalkStats;
  readonly filesIndexed: number;
  readonly nodesWritten: number;
  readonly edgesWritten: number;
  readonly opsExecuted: number;
  readonly warnings: readonly IndexWarning[];
  readonly durationMs: number;
  readonly cancelled: boolean;
}

function fileRow(input: {
  readonly path: string;
  readonly language: GrammarId;
  readonly contentHash: string;
  readonly loc: number;
  readonly indexedAt: string;
}): NodeRow {
  return {
    labels: ["FILE"],
    properties: {
      path: input.path,
      name: input.path.split("/").pop() ?? input.path,
      language: input.language,
      content_hash: input.contentHash,
      // Pinned at 1: MERGE + SET n += props resets this every run, and
      // bumping it monotonically needs a read-modify-write this per-file
      // writer doesn't do. M1.1 (the incremental writer) owns the fix.
      version: 1,
      status: "ready",
      indexed_at: input.indexedAt,
      loc: input.loc,
    },
  };
}

/** One deduplicated warning per (kind, language) — a workspace with 4,000 `.js` files gets one line, not 4,000. */
function warningKey(w: Pick<IndexWarning, "kind" | "language">): string {
  return `${w.kind}:${w.language ?? ""}`;
}

export async function indexWorkspace(
  config: CpgConfig,
  deps: IndexWorkspaceDeps,
  hooks: IndexHooks = {},
): Promise<IndexReport> {
  const start = Date.now();
  const resolveAdapter = deps.adapterFor ?? defaultAdapterFor;
  const now = deps.now ?? (() => new Date().toISOString());
  const validate = deps.validate ?? true;
  const yieldBetweenFiles = hooks.yieldBetweenFiles ?? (async () => {});

  const warnings: IndexWarning[] = [];
  const seenWarnings = new Set<string>();
  function warn(w: IndexWarning): void {
    const key = warningKey(w);
    if (seenWarnings.has(key)) {
      return;
    }
    seenWarnings.add(key);
    warnings.push(w);
    hooks.onWarning?.(w);
  }

  let nodesWritten = 0;
  let edgesWritten = 0;
  let opsExecuted = 0;
  let filesIndexed = 0;
  let cancelled = false;

  const { files, stats: walkStats } = await walkWorkspace(config.walk);

  hooks.onProgress?.({
    phase: "walk",
    filesTotal: files.length,
    filesDone: 0,
    nodesWritten: 0,
    edgesWritten: 0,
  });

  // Sequential by design (see module doc): a parse pool is M1's, and per-file
  // extraction/writes must stay ordered so progress reporting and abort
  // checks land between whole files, never mid-file.
  /* eslint-disable no-await-in-loop */
  for (const entry of files) {
    if (hooks.signal?.aborted) {
      cancelled = true;
      break;
    }

    const adapter = resolveAdapter(entry.language);
    if (adapter === undefined) {
      warn({
        kind: "unsupported-grammar",
        language: entry.language,
        message: `${entry.language} has no declaration adapter yet (M0.7).`,
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(entry.absolutePath);
    } catch (error) {
      warn({
        kind: "read-failed",
        path: entry.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const contentHash = hashBytes(bytes);
    const text = bytes.toString("utf8");
    const loc = text.length === 0 ? 0 : text.split("\n").length;

    let delta: GraphDelta;
    try {
      delta = await extractFile(deps.backend, adapter, { path: entry.path, text });
    } catch (error) {
      warn({
        kind: "parse-failed",
        path: entry.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    delta.nodes.unshift(
      fileRow({ path: entry.path, language: entry.language, contentHash, loc, indexedAt: now() }),
    );

    if (validate) {
      assertGraphDeltaValid(delta);
    }

    let write: WriteReport;
    try {
      write = await deps.store.writeDelta(delta);
    } catch (error) {
      warn({
        kind: "write-failed",
        path: entry.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    filesIndexed++;
    nodesWritten += write.nodesWritten;
    edgesWritten += write.edgesWritten;
    opsExecuted += write.opsExecuted;

    hooks.onProgress?.({
      phase: "index",
      filesTotal: files.length,
      filesDone: filesIndexed,
      currentFile: entry.path,
      nodesWritten,
      edgesWritten,
    });

    await yieldBetweenFiles();
  }
  /* eslint-enable no-await-in-loop */

  hooks.onProgress?.({
    phase: "done",
    filesTotal: files.length,
    filesDone: filesIndexed,
    nodesWritten,
    edgesWritten,
  });

  return {
    root: config.root,
    walk: walkStats,
    filesIndexed,
    nodesWritten,
    edgesWritten,
    opsExecuted,
    warnings,
    durationMs: Date.now() - start,
    cancelled,
  };
}
