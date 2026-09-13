/**
 * The language adapter seam for declaration and call extraction (GE-FR19's
 * "extract declarations/imports/calls" interface; imports land in a later
 * unit, M0.7/M0.9's remaining scope).
 *
 * `walk.ts` owns everything language-neutral: descent, the scope stack,
 * parent-relative ordinals, id assignment, `DECLARES`/`HAS_PARAM` edges,
 * SYMBOL minting and `CALLS`/`REACHING_DEF` emission. An adapter only
 * answers "what does this node mean" one node at a time — for a
 * declaration (`classify`) or, since M0.7, for an expression-tier node
 * (`classifyExpression`) — never how to assemble a graph from the answer.
 * Everything still uninterpreted — control flow, most statements — is
 * simply not classified, which is the sparse-by-design boundary (PR1) made
 * literal: no node for a thing means the adapter returned `undefined` for it.
 */
import type { SymbolSegment } from "../identity/symbol-id";
import type { GrammarId } from "../parser/grammars";
import type { CALL_KIND, METHOD_KIND, TYPE_DECL_KIND } from "../schema/enums";
import type { SyntaxNode } from "./syntax";

export type TypeDeclKind = (typeof TYPE_DECL_KIND)[number];
export type MethodKind = (typeof METHOD_KIND)[number];
export type CallKind = (typeof CALL_KIND)[number];

export interface ParamInfo {
  readonly name: string;
  readonly node: SyntaxNode;
  readonly typeText?: string;
  readonly defaultText?: string;
}

export interface TypeDeclInfo {
  readonly declares: "TYPE_DECL";
  readonly name: string;
  readonly kind: TypeDeclKind;
  readonly exported: boolean;
  readonly structural: boolean;
  readonly docstringHead?: string;
  /** This declaration's own body container — its namedChildren are walked for nested METHOD/MEMBER. */
  readonly body: SyntaxNode | undefined;
}

export interface MethodInfo {
  readonly declares: "METHOD";
  readonly name: string;
  readonly kind: MethodKind;
  readonly signature: string;
  readonly exported: boolean;
  readonly async: boolean;
  readonly docstringHead?: string;
  readonly params: readonly ParamInfo[];
  /** This method's own body — the expression region Pass B descends for CALL/REACHING_DEF. */
  readonly body?: SyntaxNode;
}

export interface MemberInfo {
  readonly declares: "MEMBER";
  readonly name: string;
  readonly typeText?: string;
  readonly visibility?: string;
  /** This member's initializer, if any — its own expression region. */
  readonly value?: SyntaxNode;
}

export type DeclarationInfo = TypeDeclInfo | MethodInfo | MemberInfo;

/** Which container's direct children are being classified. */
export type ContainerKind = "MODULE" | "TYPE_DECL";

/** One call argument. `identifier` is set only for a bare name reference — REACHING_DEF's only match shape. */
export interface ArgInfo {
  readonly node: SyntaxNode;
  readonly identifier?: string;
}

/**
 * How a callee should be attributed to a SYMBOL, decided by the adapter
 * (it alone knows this language's receiver/self conventions and its own
 * builtin table) and consumed by `walk.ts` as a plain discriminant:
 *
 * - `local-name` — a bare identifier call (`helper()`); `walk.ts` resolves
 *   `name` against this file's own top-level METHOD/TYPE_DECL names.
 * - `local-this` — a receiver-qualified call whose receiver is this
 *   language's self-reference (`this`/`self`); `walk.ts` resolves `name`
 *   against the nearest enclosing TYPE_DECL, if any.
 * - `builtin` — the adapter itself resolved the callee against its own
 *   frozen global/stdlib table; `walk.ts` mints the SYMBOL directly from
 *   `scheme`/`package`/`segments`, no further lookup.
 * - `none` — unattributable in this slice (an unresolved receiver, a
 *   computed callee, anything requiring type information). No SYMBOL, no
 *   `CALLS` edge — the CALL node is still emitted (README rule 2: no
 *   bare-name SYMBOLs for what isn't attributed).
 */
export interface BuiltinTarget {
  readonly scheme: string;
  readonly package: string;
  readonly segments: readonly SymbolSegment[];
}

export type CalleeAttribution =
  | {
      readonly kind: "local-name";
      readonly name: string;
      /**
       * Consulted only if `name` is NOT declared as a top-level
       * METHOD/TYPE_DECL in this file — a bare call to a global/builtin
       * (`print(...)`, `fetch(...)`) is syntactically identical to a bare
       * call to a sibling declaration; only `walk.ts`'s file-scoped
       * declaration table can tell them apart, so the adapter hands over
       * both candidates and lets `walk.ts` decide which one actually
       * applies.
       */
      readonly fallback?: BuiltinTarget;
    }
  | { readonly kind: "local-this"; readonly name: string }
  | ({ readonly kind: "builtin" } & BuiltinTarget)
  | { readonly kind: "none" };

export interface CallInfo {
  readonly emits: "CALL";
  readonly kind: CallKind;
  readonly calleeName: string;
  readonly receiverText?: string;
  readonly args: readonly ArgInfo[];
  readonly callee: CalleeAttribution;
}

/**
 * Pass B's per-node verdict while descending an expression region (a
 * METHOD body, a MEMBER initializer, or an unclaimed MODULE-level
 * statement). `undefined` means "not interesting, descend ordinarily" —
 * the same sparse-by-default convention `classify` uses.
 */
export type ExpressionVerdict =
  | CallInfo
  | { readonly emits: "none"; readonly descend: "transparent" }
  | { readonly emits: "none"; readonly descend: "stop" };

export interface LanguageAdapter {
  readonly grammarId: GrammarId;
  /** `SYMBOL.language`. Distinct from `grammarId`: a `.tsx` file's adapter still reports `"typescript"`. */
  readonly language: string;
  /** This grammar's root node type for a whole file, e.g. `"module"` / `"program"`. */
  readonly moduleRootType: string;
  /** Derives the MODULE's own scope-frame name from its workspace-relative path. */
  moduleName(path: string): string;
  /**
   * Classifies one direct child of a container as a declaration, or
   * `undefined` if this slice does not track it. `container` is passed
   * because the same AST node type can mean different things depending on
   * where it sits — a Python `function_definition` directly under a
   * `TYPE_DECL`'s body is a `method` (or `constructor`); the identical node
   * type under `MODULE` is a plain `function`. The walker always knows
   * which container it is descending, so it costs it nothing to say.
   */
  classify(node: SyntaxNode, container: ContainerKind): DeclarationInfo | undefined;
  /**
   * Classifies one node encountered while descending an expression region
   * (M0.7/M0.9). Optional: an adapter with no calls slice (or the fake
   * adapters `walk.test.ts` builds) simply never enters Pass B.
   */
  classifyExpression?(node: SyntaxNode): ExpressionVerdict | undefined;
  /**
   * Every name a REGION's own body binds locally (a `const`/`let`
   * declarator's name, a Python assignment target, a `for` binder, an
   * `except ... as e`), so `walk.ts` can shadow an outer MEMBER/PARAM
   * binding of the same name for `REACHING_DEF` — an over-approximation of
   * block scope by function scope, not full binding resolution.
   */
  localBindings?(regionRoot: SyntaxNode): readonly string[] | undefined;
}
