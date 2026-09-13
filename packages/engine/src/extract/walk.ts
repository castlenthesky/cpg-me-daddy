import { extendScope, makeNodeId, type ScopeSegment } from "../identity/node-id";
import {
  descriptorsForScope,
  externalOwner,
  localOwner,
  makeSymbolFqn,
} from "../identity/symbol-id";
import type { GraphDelta } from "../schema/validate";
/**
 * The shared extraction spine (M0.6/M0.8's declarations slice, extended by
 * M0.7/M0.9 with calls/SYMBOLs/data flow): one descent of the tree that is
 * entirely language-neutral. Everything language-specific lives behind
 * `LanguageAdapter` (`./adapter.ts`); this file owns the scope stack, id
 * assignment, the `DECLARES`/`HAS_PARAM` edges every language produces the
 * same way, SYMBOL minting, and `CALLS`/`IN_SCOPE`/`REACHING_DEF` emission.
 *
 * Two passes over one file:
 *
 * Pass A (`walkContainer`, unchanged in shape from M0.6/M0.8) descends
 * declarations — the MODULE root's own children, and a TYPE_DECL's body.
 * It ALSO collects, as a byproduct, everything Pass B needs before Pass B
 * starts: every top-level METHOD/TYPE_DECL name (so a bare call can resolve
 * to a sibling declared anywhere in the file, forward references included —
 * matching how JS/Python top-level declarations are actually visible to
 * each other by the time any of them runs), every module-level MEMBER in
 * source order (so REACHING_DEF can respect "no forward reference"), and
 * every expression region still to walk: unclaimed MODULE-level statements,
 * MEMBER initializers, and METHOD bodies.
 *
 * Pass B (`walkRegion`) runs only after Pass A has finished the whole file,
 * one region at a time, each with its own per-region CALL ordinal counter
 * and its own snapshot of what bindings are visible to it. A METHOD's body
 * is genuinely descended now — the one boundary Pass B enforces itself is
 * PR1's sparse expression tier: only CALL nodes are minted; everything else
 * (control flow, other expressions) is simply walked through, never
 * classified into a node. A nested NAMED declaration (a function/class
 * declared inside a method body) is a hard stop, not descended at all —
 * `identity/node-id.ts`'s name-only frame join depends on METHOD/TYPE_DECL
 * frames never repeating at two different depths, and this is what keeps
 * that true now that a METHOD is no longer always a leaf.
 */
import type {
  ArgInfo,
  BuiltinTarget,
  CalleeAttribution,
  ExpressionVerdict,
  LanguageAdapter,
  MemberInfo,
  MethodInfo,
  TypeDeclInfo,
} from "./adapter";
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
  readonly state: FileState;
}

/** A source-order binding: a MEMBER or PARAM name to the id of the node that declares it. */
interface Binding {
  readonly name: string;
  readonly id: string;
}

/** One expression region still to walk in Pass B, queued by Pass A. */
interface PendingRegion {
  readonly root: SyntaxNode;
  /** This region's OWN scope chain — the same frames its declaring node's id uses. */
  readonly scope: readonly ScopeSegment[];
  readonly enclosingId: string;
  readonly enclosingLabel: "METHOD" | "MODULE";
  /** Module-level MEMBERs declared strictly before this region — REACHING_DEF's no-forward-reference rule. */
  readonly moduleBindingsSnapshot: readonly Binding[];
  /** This region's own METHOD params, if it is a METHOD body; empty otherwise. */
  readonly paramBindings: readonly Binding[];
}

/** Cross-region state Pass A assembles for Pass B, once per file. */
interface FileState {
  readonly path: string;
  readonly adapter: LanguageAdapter;
  readonly builder: DeltaBuilder;
  readonly moduleId: string;
  /** Every top-level (MODULE-scope) METHOD/TYPE_DECL, by name — whole-file visibility, forward references included. */
  readonly topLevelCallables: Map<string, readonly ScopeSegment[]>;
  /** Module-level MEMBERs, in source order. */
  readonly moduleMembers: Binding[];
  readonly regions: PendingRegion[];
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

  const state: FileState = {
    path,
    adapter,
    builder,
    moduleId,
    topLevelCallables: new Map(),
    moduleMembers: [],
    regions: [],
  };

  walkContainer(root.namedChildren, {
    path,
    adapter,
    builder,
    scope: [],
    parentId: moduleId,
    parentLabel: "MODULE",
    state,
  });

  // Pass B: every region Pass A queued, now that the whole file's
  // top-level declarations and module-member source order are known.
  for (const region of state.regions) {
    walkRegion(region, state);
  }

  return builder.build();
}

function walkContainer(children: readonly SyntaxNode[], ctx: WalkContext): void {
  for (const child of children) {
    const info = ctx.adapter.classify(child, ctx.parentLabel);
    if (info === undefined) {
      // Not a declaration this slice tracks (PR1's sparse boundary). At
      // MODULE level, an unclaimed statement is still an expression region
      // — the "bare console.log(...)" case the hello-world golden is built
      // from. A TYPE_DECL body's unclaimed children stay unvisited: a
      // documented gap (decorators, stray class-body statements), not this
      // unit's job.
      if (ctx.parentLabel === "MODULE") {
        ctx.state.regions.push({
          root: child,
          scope: ctx.scope,
          enclosingId: ctx.state.moduleId,
          enclosingLabel: "MODULE",
          moduleBindingsSnapshot: [...ctx.state.moduleMembers],
          paramBindings: [],
        });
      }
      continue;
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

/** Mints this declaration's own SYMBOL and its `DEFINES` edge — MEMBER/METHOD/TYPE_DECL only (M0.7/M0.9). */
function defineSymbol(
  ctx: WalkContext,
  fromLabel: "MEMBER" | "METHOD" | "TYPE_DECL",
  fromKey: string,
  scope: readonly ScopeSegment[],
  symbolKind: string,
): void {
  const fqn = makeSymbolFqn(localOwner(ctx.path), descriptorsForScope(scope));
  ctx.builder.addSymbol({ fqn, kind: symbolKind, language: ctx.adapter.language });
  ctx.builder.addEdge({
    type: "DEFINES",
    fromLabel,
    toLabel: "SYMBOL",
    fromKey,
    toKey: fqn,
  });
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
  defineSymbol(ctx, "TYPE_DECL", id, scope, "class");

  if (ctx.parentLabel === "MODULE") {
    ctx.state.topLevelCallables.set(info.name, scope);
  }

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
  defineSymbol(ctx, "MEMBER", id, scope, "variable");

  // Every MEMBER — module-level or class-level — is reached from MODULE or
  // a TYPE_DECL container, never from inside a METHOD body (Pass A never
  // descends one), so its initializer's enclosing scope is always MODULE.
  if (info.value !== undefined) {
    ctx.state.regions.push({
      root: info.value,
      scope,
      enclosingId: ctx.state.moduleId,
      enclosingLabel: "MODULE",
      moduleBindingsSnapshot: [...ctx.state.moduleMembers],
      paramBindings: [],
    });
  }

  if (ctx.parentLabel === "MODULE") {
    ctx.state.moduleMembers.push({ name: info.name, id });
  }
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
  defineSymbol(ctx, "METHOD", id, scope, ctx.parentLabel === "TYPE_DECL" ? "method" : "function");

  if (ctx.parentLabel === "MODULE") {
    ctx.state.topLevelCallables.set(info.name, scope);
  }

  const paramBindings: Binding[] = [];
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
    paramBindings.push({ name: param.name, id: paramId });
  });

  if (info.body !== undefined) {
    ctx.state.regions.push({
      root: info.body,
      scope,
      enclosingId: id,
      enclosingLabel: "METHOD",
      moduleBindingsSnapshot: [...ctx.state.moduleMembers],
      paramBindings,
    });
  }
}

// ---------------------------------------------------------------------------
// Pass B: expression regions (M0.7/M0.9).
// ---------------------------------------------------------------------------

/** The nearest enclosing TYPE_DECL frame in a region's own scope chain, if any. */
function enclosingTypeDecl(scope: readonly ScopeSegment[]): ScopeSegment | undefined {
  for (let i = scope.length - 1; i >= 0; i--) {
    const frame = scope[i]!;
    if (frame.kind === "TYPE_DECL") {
      return frame;
    }
  }
  return undefined;
}

interface ResolvedCallee {
  readonly fqn: string;
  readonly kind: string;
  readonly status: "resolved" | "external";
  /** Set only for an external (builtin) resolution — kept as properties alongside the fqn's own prefix. */
  readonly scheme?: string;
  readonly package?: string;
}

function resolveBuiltin(target: BuiltinTarget, hasReceiver: boolean): ResolvedCallee {
  const fqn = makeSymbolFqn(externalOwner(target.scheme, target.package), target.segments);
  return {
    fqn,
    kind: hasReceiver ? "method" : "function",
    status: "external",
    scheme: target.scheme,
    package: target.package,
  };
}

/** Resolves a callee attribution to a SYMBOL, or `undefined` if unattributable — no SYMBOL, no CALLS edge. */
function resolveCallee(
  attribution: CalleeAttribution,
  hasReceiver: boolean,
  regionScope: readonly ScopeSegment[],
  state: FileState,
): ResolvedCallee | undefined {
  switch (attribution.kind) {
    case "local-name": {
      const target = state.topLevelCallables.get(attribution.name);
      if (target !== undefined) {
        const lastFrame = target[target.length - 1];
        const fqn = makeSymbolFqn(localOwner(state.path), descriptorsForScope(target));
        const kind = lastFrame?.kind === "TYPE_DECL" ? "class" : "function";
        return { fqn, kind, status: "resolved" };
      }
      return attribution.fallback === undefined
        ? undefined
        : resolveBuiltin(attribution.fallback, hasReceiver);
    }
    case "local-this": {
      const typeDecl = enclosingTypeDecl(regionScope);
      if (typeDecl === undefined) {
        return undefined;
      }
      const segments = descriptorsForScope([typeDecl, { kind: "METHOD", name: attribution.name }]);
      return {
        fqn: makeSymbolFqn(localOwner(state.path), segments),
        kind: "method",
        status: "resolved",
      };
    }
    case "builtin":
      return resolveBuiltin(attribution, hasReceiver);
    case "none":
      return undefined;
  }
}

interface ResolvedBinding extends Binding {
  /** REACHING_DEF's `fromLabel` — which kind of node actually declares this binding. */
  readonly fromLabel: "MEMBER" | "PARAM";
}

/** Resolves one call argument to a REACHING_DEF source, respecting the region's own shadow set and bindings. */
function resolveArg(
  arg: ArgInfo,
  region: PendingRegion,
  shadow: ReadonlySet<string>,
): ResolvedBinding | undefined {
  if (arg.identifier === undefined || shadow.has(arg.identifier)) {
    return undefined;
  }
  const param = region.paramBindings.find((b) => b.name === arg.identifier);
  if (param !== undefined) {
    return { ...param, fromLabel: "PARAM" };
  }
  // Last match wins: the most recent module-level definition strictly
  // before this region is the one whose value is actually live here.
  for (let i = region.moduleBindingsSnapshot.length - 1; i >= 0; i--) {
    const candidate = region.moduleBindingsSnapshot[i]!;
    if (candidate.name === arg.identifier) {
      return { ...candidate, fromLabel: "MEMBER" };
    }
  }
  return undefined;
}

function walkRegion(region: PendingRegion, state: FileState): void {
  const shadow = new Set<string>(state.adapter.localBindings?.(region.root) ?? []);
  const ordinals = new Map<string, number>();
  const seenReachingDef = new Set<string>();

  function nextOrdinal(name: string): number {
    const current = ordinals.get(name) ?? 0;
    ordinals.set(name, current + 1);
    return current;
  }

  function emitCall(node: SyntaxNode, info: Extract<ExpressionVerdict, { emits: "CALL" }>): void {
    const ordinal = nextOrdinal(info.calleeName);
    const callScope = extendScope(region.scope, { kind: "CALL", name: info.calleeName });
    const id = makeNodeId({ path: state.path, kind: "CALL", scope: callScope, ordinal });

    state.builder.addNode("CALL", {
      id,
      callee_name: info.calleeName,
      ...(info.receiverText !== undefined ? { receiver_text: info.receiverText } : {}),
      args_count: info.args.length,
      file: state.path,
      range: formatRange(node.startPosition, node.endPosition),
      kind: info.kind,
      status: "ready",
    });
    state.builder.addEdge({
      type: "IN_SCOPE",
      fromLabel: "CALL",
      toLabel: region.enclosingLabel,
      fromKey: id,
      toKey: region.enclosingId,
    });

    const resolved = resolveCallee(
      info.callee,
      info.receiverText !== undefined,
      region.scope,
      state,
    );
    if (resolved !== undefined) {
      state.builder.addSymbol({
        fqn: resolved.fqn,
        kind: resolved.kind,
        language: state.adapter.language,
        ...(resolved.scheme !== undefined ? { scheme: resolved.scheme } : {}),
        ...(resolved.package !== undefined ? { package: resolved.package } : {}),
      });
      state.builder.addEdge({
        type: "CALLS",
        fromLabel: "CALL",
        toLabel: "SYMBOL",
        fromKey: id,
        toKey: resolved.fqn,
        properties: { status: resolved.status },
      });
    }

    for (const arg of info.args) {
      const source = resolveArg(arg, region, shadow);
      if (source === undefined) {
        continue;
      }
      const dedupeKey = `${source.id}|${id}|${arg.identifier}`;
      if (seenReachingDef.has(dedupeKey)) {
        continue;
      }
      seenReachingDef.add(dedupeKey);
      state.builder.addEdge({
        type: "REACHING_DEF",
        fromLabel: source.fromLabel,
        toLabel: "CALL",
        fromKey: source.id,
        toKey: id,
        properties: { variable: arg.identifier! },
      });
    }
  }

  function visit(node: SyntaxNode): void {
    const verdict = state.adapter.classifyExpression?.(node);
    if (verdict === undefined) {
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }
    if (verdict.emits === "CALL") {
      emitCall(node, verdict);
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }
    if (verdict.descend === "transparent") {
      for (const child of node.namedChildren) {
        visit(child);
      }
    }
    // descend === "stop": a nested named declaration. Do not descend.
  }

  visit(region.root);
}
