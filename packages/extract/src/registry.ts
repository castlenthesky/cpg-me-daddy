// GrammarId -> LanguageAdapter (controller decision 96). Ported from archive
// 27361a3:packages/engine/src/extract/registry.ts. At U6a only python has an adapter: typescript and
// tsx arrive in U6b, and javascript has none on purpose (the TS adapter would silently drop every JS
// class field, a quietly wrong graph), so extract FAILS `grammar-unsupported` for them (I25).

import type { GrammarId, LanguageAdapter } from './contract';

/** The grammars with an adapter, in this order: `Extractor.grammars`. */
export const ADAPTER_GRAMMARS: readonly GrammarId[] = ['python'];

/**
 * The adapter for `grammarId`, or `undefined`. An own-key lookup: a name on Object.prototype
 * (`toString`, `__proto__`) has no adapter.
 */
export function adapterFor(_grammarId: GrammarId): LanguageAdapter | undefined {
  throw new Error('SEAT: adapterFor lands in U6a.2-2');
}
