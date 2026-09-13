/**
 * `GrammarId -> LanguageAdapter`. `grammars.ts` registers four grammars;
 * only three have a declaration adapter today.
 *
 * `javascript` deliberately has none — `undefined`, not the TypeScript
 * adapter. The JS grammar names a class field `field_definition`;
 * `typescript.ts` matches `public_field_definition`. Aliasing the two would
 * silently drop every class field in every `.js` file: a quietly wrong
 * graph, which is worse than a visibly missing one at a walking-skeleton
 * checkpoint. A caller sees `undefined` and skips the file with one warning
 * (see `indexer/index-workspace.ts`), until M0.7 gives `.js` its own adapter.
 */
import type { GrammarId } from "../parser/grammars";
import type { LanguageAdapter } from "./adapter";
import { pythonAdapter } from "./python";
import { tsxAdapter, typeScriptAdapter } from "./typescript";

/** Grammar ids with a declaration adapter today. A subset of `GRAMMAR_IDS`. */
export const SUPPORTED_GRAMMAR_IDS: readonly GrammarId[] = ["typescript", "tsx", "python"];

const REGISTRY: Partial<Record<GrammarId, LanguageAdapter>> = {
  typescript: typeScriptAdapter,
  tsx: tsxAdapter,
  python: pythonAdapter,
};

/** The declaration adapter for `id`, or `undefined` if none exists yet. */
export function adapterFor(id: GrammarId): LanguageAdapter | undefined {
  return REGISTRY[id];
}
