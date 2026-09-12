/**
 * The language adapter seam for declaration extraction (GE-FR19's
 * "extract declarations/imports/calls" interface, declarations subset —
 * imports/calls land in a later unit).
 *
 * `walk.ts` owns everything language-neutral: descent, the scope stack,
 * parent-relative ordinals, id assignment, `DECLARES`/`HAS_PARAM` edges.
 * An adapter only answers one question, node by node: "is this a
 * declaration this schema tracks, and what does it say?" Everything else —
 * control flow, expressions, statements this slice doesn't track — is
 * simply not classified, which is the sparse-by-design boundary (PR1) made
 * literal: no node for a thing means `classify` returned `undefined` for it.
 */
import type { GrammarId } from "../parser/grammars";
import type { METHOD_KIND, TYPE_DECL_KIND } from "../schema/enums";
import type { SyntaxNode } from "./syntax";

export type TypeDeclKind = (typeof TYPE_DECL_KIND)[number];
export type MethodKind = (typeof METHOD_KIND)[number];

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
}

export interface MemberInfo {
  readonly declares: "MEMBER";
  readonly name: string;
  readonly typeText?: string;
  readonly visibility?: string;
}

export type DeclarationInfo = TypeDeclInfo | MethodInfo | MemberInfo;

/** Which container's direct children are being classified. */
export type ContainerKind = "MODULE" | "TYPE_DECL";

export interface LanguageAdapter {
  readonly grammarId: GrammarId;
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
}
