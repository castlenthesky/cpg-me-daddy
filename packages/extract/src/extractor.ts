// The front door's Extractor (C-EXTRACT; controller decision 96). Ported from archive
// f18ee71:packages/engine/src/extract/index.ts, minus the parse: the caller owns the tree, so extract
// is synchronous and does no I/O (I2).

import type { ExtractOutcome, ExtractRequest, Extractor, LanguageAdapter } from './contract';
import { walkFile } from './walk';

/**
 * Extracts one file through `adapter`. Never throws (I4): every failure is an outcome whose
 * `error.path` is `request.path` when that is a string, else `''`. The checks, in order:
 * 1. `path-not-relative`: the path is not a WorkspacePath, or is `'.'`;
 * 2. `tier-disabled`: `tiers.expression` is `true` (no expression tier yet; I16 forbids accepting it
 *    and doing nothing);
 * 3. `budget-invalid`: a present `maxNodes` that is not a positive safe integer, or a present
 *    `maxDepth` that is not a non-negative safe integer;
 * 4. `root-type-mismatch`: `root.type` is not `adapter.moduleRootType`;
 * 5. `walkFile` into an `ElementBuilder`, then `build()`. Anything thrown, an `ExtractInvariantError`
 *    included, is `internal` with the thrown message.
 * The file: the request's path, grammarId and revision_id; the four built arrays; stats
 * `{ astNodesVisited, structuralNodes, expressionNodes, lineCount }`, the middle two counted by node
 * tier and `lineCount` the request's; `elementDigest` and `interfaceHash` over what was built. A walk
 * that stopped on the budget gives `truncated` with its report, never a short `ok` (I17).
 */
export function extractFile(_request: ExtractRequest, _adapter: LanguageAdapter): ExtractOutcome {
  throw new Error(`SEAT: extractFile (over ${walkFile.name}) lands in U6a.2-2`);
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
  throw new Error('SEAT: createExtractor lands in U6a.2-2');
}
