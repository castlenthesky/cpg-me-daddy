// The front door's Extractor (C-EXTRACT; controller decision 96). Ported from archive
// f18ee71:packages/engine/src/extract/index.ts, minus the parse: the caller owns the tree, so extract
// is synchronous and does no I/O (I2).

import { isWorkspacePath } from '@cpg/model';
import { ElementBuilder } from './builder';
import type {
  ExtractErrorCode,
  ExtractedFile,
  ExtractOutcome,
  ExtractRequest,
  Extractor,
  GrammarId,
  LanguageAdapter,
} from './contract';
import { elementDigest, interfaceHash } from './digest';
import { ADAPTER_GRAMMARS, adapterFor } from './registry';
import { EXTRACT_CONTRACT_VERSION } from './version';
import { walkFile } from './walk';

function safePath(request: ExtractRequest): string {
  try {
    const path: unknown = request.path;
    return typeof path === 'string' ? path : '';
  } catch {
    return '';
  }
}

function fail(code: ExtractErrorCode, message: string, path: string): ExtractOutcome {
  return { kind: 'failed', error: { code, message, path } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extracts one file through `adapter`. Never throws (I4): every failure is an outcome whose
 * `error.path` is `request.path` when that is a string, else `''`. The checks, in order:
 * 1. `path-not-relative`: the path is not a WorkspacePath, or is `'.'`;
 * 2. `tier-disabled`: `tiers.expression` is `true` (no expression tier yet; I16 forbids accepting it
 *    and doing nothing);
 * 3. `budget-invalid`: a present `maxNodes` that is not a positive safe integer, or a present
 *    `maxDepth` that is not a non-negative safe integer;
 * 4. `root-type-mismatch`: `root.type` is neither `adapter.moduleRootType` nor `'ERROR'` (tree-sitter's
 *    ERROR, any grammar; decision 116);
 * 5. `walkFile` into an `ElementBuilder`, then `build()`. Anything thrown, an `ExtractInvariantError`
 *    included, is `internal` with the thrown message.
 * The file: the request's path, grammarId and revision_id; the four built arrays; stats
 * `{ astNodesVisited, structuralNodes, expressionNodes, lineCount }`, the middle two counted by node
 * tier and `lineCount` the request's; `elementDigest` and `interfaceHash` over what was built. A walk
 * that stopped on the budget gives `truncated` with its report, never a short `ok` (I17).
 */
export function extractFile(request: ExtractRequest, adapter: LanguageAdapter): ExtractOutcome {
  try {
    const rawPath: unknown = request.path;
    if (typeof rawPath !== 'string' || !isWorkspacePath(rawPath) || rawPath === '.') {
      return fail(
        'path-not-relative',
        `path is not a workspace-relative file path: ${JSON.stringify(rawPath)}`,
        typeof rawPath === 'string' ? rawPath : '',
      );
    }

    if (request.tiers?.expression === true) {
      return fail('tier-disabled', 'expression tier is not supported yet', rawPath);
    }

    const maxNodes = request.budget?.maxNodes;
    if (maxNodes !== undefined && (!Number.isSafeInteger(maxNodes) || maxNodes < 1)) {
      return fail(
        'budget-invalid',
        `budget.maxNodes must be a positive safe integer, got ${String(maxNodes)}`,
        rawPath,
      );
    }

    const maxDepth = request.budget?.maxDepth;
    if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 0)) {
      return fail(
        'budget-invalid',
        `budget.maxDepth must be a non-negative safe integer, got ${String(maxDepth)}`,
        rawPath,
      );
    }

    if (request.root.type !== adapter.moduleRootType && request.root.type !== 'ERROR') {
      return fail(
        'root-type-mismatch',
        `expected root node type "${adapter.moduleRootType}" or "ERROR", got "${request.root.type}"`,
        rawPath,
      );
    }

    const builder = new ElementBuilder(rawPath, request.revision_id);
    const walk = walkFile(request, adapter, builder);
    const built = builder.build();

    let structuralNodes = 0;
    let expressionNodes = 0;
    for (const node of built.nodes) {
      if (node.tier === 'structural') {
        structuralNodes += 1;
      } else {
        expressionNodes += 1;
      }
    }

    const file: ExtractedFile = {
      path: rawPath,
      grammarId: request.grammarId,
      revision_id: request.revision_id,
      nodes: built.nodes,
      symbols: built.symbols,
      edges: built.edges,
      refSites: built.refSites,
      stats: {
        astNodesVisited: walk.astNodesVisited,
        structuralNodes,
        expressionNodes,
        lineCount: request.lineCount,
      },
      elementDigest: elementDigest(built),
      interfaceHash: interfaceHash(built.nodes),
    };

    if (walk.truncation !== undefined) {
      return { kind: 'truncated', file, truncation: walk.truncation };
    }
    return { kind: 'ok', file };
  } catch (error: unknown) {
    return fail('internal', errorMessage(error), safePath(request));
  }
}

/**
 * The Extractor: `contractVersion` is EXTRACT_CONTRACT_VERSION, `grammars` is ADAPTER_GRAMMARS.
 * - `extract` routes by `request.grammarId` through `adapterFor`. No adapter (typescript, tsx,
 *   javascript, anything unknown) is `failed: grammar-unsupported`, never an empty result (I25),
 *   checked before everything `extractFile` checks; otherwise it is `extractFile`. Never throws.
 * - `coverage(grammarId)` is that adapter's manifest; for a grammar with no adapter it throws an
 *   Error naming the grammar (only python has a CoverageManifest at U6a).
 * - `adapter-missing` is not produced: `grammars` is derived from the registry, so a listed grammar
 *   always has an adapter.
 */
export function createExtractor(): Extractor {
  const covered = ADAPTER_GRAMMARS.join(', ');
  return {
    contractVersion: EXTRACT_CONTRACT_VERSION,
    grammars: ADAPTER_GRAMMARS,
    coverage(grammarId: GrammarId) {
      const adapter = adapterFor(grammarId);
      if (adapter === undefined) {
        throw new Error(
          `C-EXTRACT: no CoverageManifest for grammar "${grammarId}"; extract covers ${covered}`,
        );
      }
      return adapter.coverage();
    },
    extract(request: ExtractRequest) {
      try {
        const adapter = adapterFor(request.grammarId);
        if (adapter === undefined) {
          return fail(
            'grammar-unsupported',
            `no extractor for grammar "${request.grammarId}" (extract covers ${covered})`,
            safePath(request),
          );
        }
        return extractFile(request, adapter);
      } catch (error: unknown) {
        return fail('internal', errorMessage(error), safePath(request));
      }
    },
  };
}
