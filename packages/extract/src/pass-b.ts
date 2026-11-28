// Pass B, the calls (U6a.2-4a, BMO-133). SEAT: `walkCalls` emits nothing until the implementation lands,
// and nothing calls it yet; walk.ts's walkFile is to call it once Pass A has completed the file (I21).
// To be adapted from archive f18ee71:packages/engine/src/extract/walk.ts (walkRegion, resolveArg, the
// region queue) with resolveCallee REMOVED (U6a.2 acceptance): the walker resolves only a bare name
// bound at the top of this file, and emits a RefSite for every call. IMPORTs are BMO-134.

import type { ElementBuilder } from './builder';
import type { ExtractRequest, LanguageAdapter, SyntaxNode } from './contract';

/** Everything Pass A learned that Pass B needs; walk.ts may reshape it, since only walkFile calls this. */
export interface PassBInput {
  readonly request: ExtractRequest;
  readonly adapter: LanguageAdapter;
  /** The MODULE's id (`$root`). */
  readonly moduleId: string;
  /** The module's direct named children, in order: the $root region is walked from them. */
  readonly moduleChildren: readonly SyntaxNode[];
}

/**
 * SEAT. The contract (expected values in pass-b.test.ts and the fixtures come from here and from the
 * spec it cites):
 *
 * Runs only when Pass A finished the whole file (I21): walkFile does not call it after a budget hit, so a
 * truncated file has no CALL, no Pass B edge and no ref site. Pass B does not count toward
 * `astNodesVisited` or the budget (they stay Pass A's container children, as walk.ts states).
 *
 * Regions and ordinals (controller decision 92, the schema's ordinal_rule): a CALL's region is its
 * enclosing METHOD, or `$root` when no METHOD encloses it. One counter per region; every CALL in the
 * region counts, in pre-order (a call before the calls inside it, its callee's included, then source
 * order). The CALL id is `makeNodeId({ form: 'scoped', path, kind: 'CALL', scope, ordinal })` with scope
 * the METHOD's id scope (`main`, `Box.grow`) or `['$root']`. So:
 * - a METHOD's body is its region; a nested `def`/`class` in it (and its decorators) is never descended
 *   (decision 92); a `lambda` is transparent (its calls are its METHOD's);
 * - `$root` holds, in source order: module statements Pass A did not declare (walked whole), MEMBER
 *   initializers (module- or class-level), and the decorators of every declaration at module or class
 *   level. An ERROR node is not descended (decision 95). Parameters' defaults, annotations and class
 *   bases are not walked in v1.
 *
 * Each CALL (adapter.classifyExpression's CallInfo): a NodeElement, tier `structural`, range the
 * classified node's (the `call`, or the whole `decorator` including `@`), no nameRange, properties
 * `{ callee_name: calleeName, receiver_text?: receiverText, args_count: args.length, kind, status:
 * 'ready' }`; then an IN_SCOPE edge CALL -> its region's METHOD or the MODULE.
 *
 * CALLS (I11), only for a CallInfo with no receiverText:
 * - the name of a top-level METHOD or TYPE_DECL of this file (anywhere in the file: forward references
 *   included): CALLS `{ status: 'resolved' }` to that declaration's SYMBOL (`` `path`/name(). ``, or
 *   `` `path`/Name# `` for a class, ladder rung 08);
 * - else when `builtin` is set: the SYMBOL `makeSymbolFqn({ form: 'external', scheme, package,
 *   descriptors })` (origin `builtin`, language `adapter.language`, properties `{ kind: 'function',
 *   scheme, package }`, emitted once) and CALLS `{ status: 'external' }` to it;
 * - else nothing: no edge and no SYMBOL (no bare-name SYMBOL for what was not attributed). A receiver
 *   call (`self.f()`, `g.greet()`) never gets CALLS here, whatever its name.
 *
 * Ref sites (C-EXTRACT RefSite; I12, I20), all with `filePath` the path and `nodeId` the CALL's id; ids
 * unique within the file (archive refSites.ts: the CALL id, `<id>#recv`, `<id>#type`):
 * - one `call` site per CALL: position the start of `nameNode` (the LAST callee segment, I20),
 *   nameParts the CallInfo's; no `declined` (the extractor does not know it will not resolve);
 * - when `receiverNode` is set, a `receiver` and a `receiver-type` site: position the start of
 *   receiverNode, nameParts the call's minus its last segment, `declined: 'receiver-unknown'` (v1
 *   answers none, so the gap is counted).
 *
 * REACHING_DEF (archive resolveArg; "last match wins"): for each arg with an `identifier`, unless the
 * region's `adapter.localBindings` (per METHOD body; per statement or initializer in `$root`) names it:
 * from the region METHOD's PARAM of that name; else from the LAST module-level MEMBER of that name
 * declared before the region (the METHOD, or the `$root` statement); else nothing. Properties
 * `{ variable }`; one edge per (source, CALL, variable).
 */
export function walkCalls(_input: PassBInput, _builder: ElementBuilder): void {
  // SEAT: no CALL, IN_SCOPE, CALLS, REACHING_DEF, builtin SYMBOL or ref site yet.
}
