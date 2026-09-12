import { extendScope, makeNodeId, type ScopeSegment } from "../identity/node-id";
import type { GraphDelta } from "../schema/validate";
/**
 * The shared extraction spine (M0.6/M0.8's declarations slice): one descent
 * of the tree that is entirely language-neutral. Everything language-specific
 * lives behind `LanguageAdapter.classify()` (`./adapter.ts`); this file owns
 * the scope stack, id assignment, and the `DECLARES`/`HAS_PARAM` edges every
 * language produces the same way.
 *
 * Deliberately bounded to two container kinds: the MODULE root's own
 * children, and a TYPE_DECL's own `body`. A METHOD's body is never
 * descended into in this slice — that is the expression/statement tier
 * (calls, control flow) PR1 keeps sparse-by-design until a later unit
 * (imports/calls) earns it. A closure or nested class defined inside a
 * function is therefore not seen yet; that is a known, documented boundary,
 * not an oversight.
 */
import type { LanguageAdapter, MemberInfo, MethodInfo, TypeDeclInfo } from "./adapter";
import { DeltaBuilder } from "./delta";
import { formatRange } from "./range";
import type { SyntaxNode } from "./syntax";

export interface ExtractDeclarationsInput {
  /** Workspace-relative path. Both the `file` property and the id prefix. */
  readonly path: string;
  /** The grammar's own root node for this file (`module` / `program`). */
  readonly root: SyntaxNode;
  readonly adapter: LanguageAdapter;
}

interface WalkContext {
  readonly path: string;
  readonly adapter: LanguageAdapter;
  readonly builder: DeltaBuilder;
  /** Ancestor frames, outermost first, NOT including the current container. */
  readonly scope: readonly ScopeSegment[];
  readonly parentId: string;
  readonly parentLabel: "MODULE" | "TYPE_DECL";
}

/** Walks one file's declarations into a `GraphDelta`. DB-free, parser-agnostic beyond `SyntaxNode`. */
export function extractDeclarations(input: ExtractDeclarationsInput): GraphDelta {
  const { path, root, adapter } = input;
  if (root.type !== adapter.moduleRootType) {
    throw new Error(
      `extractDeclarations: root node type '${root.type}' does not match adapter ` +
        `'${adapter.grammarId}'s expected root '${adapter.moduleRootType}'.`,
    );
  }

  const builder = new DeltaBuilder(path);
  const moduleName = adapter.moduleName(path);
  const moduleFrame: ScopeSegment = { kind: "MODULE", name: moduleName };
  const moduleId = makeNodeId({ path, kind: "MODULE", scope: [moduleFrame] });

  builder.addNode("MODULE", {
    id: moduleId,
    name: moduleName,
    file: path,
    range: formatRange(root.startPosition, root.endPosition),
    status: "ready",
  });

  walkContainer(root.namedChildren, {
    path,
    adapter,
    builder,
    scope: [],
    parentId: moduleId,
    parentLabel: "MODULE",
  });

  return builder.build();
}

function walkContainer(children: readonly SyntaxNode[], ctx: WalkContext): void {
  for (const child of children) {
    const info = ctx.adapter.classify(child, ctx.parentLabel);
    if (info === undefined) {
      continue; // Not a declaration this slice tracks — PR1's sparse boundary.
    }
    switch (info.declares) {
      case "TYPE_DECL":
        emitTypeDecl(child, info, ctx);
        break;
      case "METHOD":
        emitMethod(child, info, ctx);
        break;
      case "MEMBER":
        emitMember(child, info, ctx);
        break;
    }
  }
}

function emitTypeDecl(node: SyntaxNode, info: TypeDeclInfo, ctx: WalkContext): void {
  const scope = extendScope(ctx.scope, { kind: "TYPE_DECL", name: info.name });
  const id = makeNodeId({ path: ctx.path, kind: "TYPE_DECL", scope });

  ctx.builder.addNode("TYPE_DECL", {
    id,
    name: info.name,
    kind: info.kind,
    file: ctx.path,
    range: formatRange(node.startPosition, node.endPosition),
    exported: info.exported,
    status: "ready",
    structural: info.structural,
    ...(info.docstringHead !== undefined ? { docstring_head: info.docstringHead } : {}),
  });
  ctx.builder.addEdge({
    type: "DECLARES",
    fromLabel: ctx.parentLabel,
    toLabel: "TYPE_DECL",
    fromKey: ctx.parentId,
    toKey: id,
  });

  if (info.body !== undefined) {
    walkContainer(info.body.namedChildren, {
      ...ctx,
      scope,
      parentId: id,
      parentLabel: "TYPE_DECL",
    });
  }
}

function emitMember(node: SyntaxNode, info: MemberInfo, ctx: WalkContext): void {
  const scope = extendScope(ctx.scope, { kind: "MEMBER", name: info.name });
  const id = makeNodeId({ path: ctx.path, kind: "MEMBER", scope });

  ctx.builder.addNode("MEMBER", {
    id,
    name: info.name,
    file: ctx.path,
    range: formatRange(node.startPosition, node.endPosition),
    ...(info.typeText !== undefined ? { type_text: info.typeText } : {}),
    ...(info.visibility !== undefined ? { visibility: info.visibility } : {}),
  });
  ctx.builder.addEdge({
    type: "DECLARES",
    fromLabel: ctx.parentLabel,
    toLabel: "MEMBER",
    fromKey: ctx.parentId,
    toKey: id,
  });
}

function emitMethod(node: SyntaxNode, info: MethodInfo, ctx: WalkContext): void {
  const scope = extendScope(ctx.scope, { kind: "METHOD", name: info.name });
  const id = makeNodeId({ path: ctx.path, kind: "METHOD", scope });

  ctx.builder.addNode("METHOD", {
    id,
    name: info.name,
    kind: info.kind,
    signature: info.signature,
    params_count: info.params.length,
    file: ctx.path,
    range: formatRange(node.startPosition, node.endPosition),
    exported: info.exported,
    async: info.async,
    status: "ready",
    ...(info.docstringHead !== undefined ? { docstring_head: info.docstringHead } : {}),
  });
  ctx.builder.addEdge({
    type: "DECLARES",
    fromLabel: ctx.parentLabel,
    toLabel: "METHOD",
    fromKey: ctx.parentId,
    toKey: id,
  });

  info.params.forEach((param, ordinal) => {
    // The ordinal is folded into the PARAM's own id, not just its
    // `ordinal` property: params are the one declaration kind where a
    // duplicate name is grammatically possible (destructured/anonymous
    // patterns later), and the ordinal is already a required, meaningful
    // property of PARAM — embedding it costs nothing today and buys
    // uniqueness before that case exists.
    const paramScope = extendScope(scope, { kind: "PARAM", name: param.name });
    const paramId = makeNodeId({ path: ctx.path, kind: "PARAM", scope: paramScope, ordinal });

    ctx.builder.addNode("PARAM", {
      id: paramId,
      name: param.name,
      ordinal,
      file: ctx.path,
      ...(param.typeText !== undefined ? { type_text: param.typeText } : {}),
      ...(param.defaultText !== undefined ? { default: param.defaultText } : {}),
    });
    ctx.builder.addEdge({
      type: "HAS_PARAM",
      fromLabel: "METHOD",
      toLabel: "PARAM",
      fromKey: id,
      toKey: paramId,
    });
  });
}
