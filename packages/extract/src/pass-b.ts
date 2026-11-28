// Pass B, the calls (U6a.2-4a, BMO-133). walk.ts's walkFile calls `walkCalls` once Pass A has completed
// the file (I21). Adapted from archive f18ee71:packages/engine/src/extract/walk.ts (walkRegion,
// resolveArg, the region queue) with resolveCallee REMOVED (U6a.2 acceptance): the walker resolves only a
// bare name bound at the top of this file or in the adapter's builtin table, and emits a RefSite for
// every call. IMPORTs are BMO-134.

import { makeNodeId, makeSymbolFqn, MODULE_SCOPE, type SourceRange } from '@cpg/model';
import type { ElementBuilder } from './builder';
import type {
  CallInfo,
  ContainerKind,
  DeclarationInfo,
  ExtractRequest,
  LanguageAdapter,
  SyntaxNode,
} from './contract';

/** A name bound by a declaration Pass A emitted, and that declaration's node id. */
export interface Binding {
  readonly name: string;
  readonly id: string;
}

/** What Pass A declared for one container child: its reading, its id and id scope, a METHOD's PARAMs. */
export interface Declared {
  readonly info: DeclarationInfo;
  readonly id: string;
  readonly scope: readonly [string, ...string[]];
  readonly params: readonly Binding[];
}

/** One child of the MODULE or of a TYPE_DECL body that Pass A visited (never an ERROR), in pre-order. */
export interface ContainerChild {
  readonly node: SyntaxNode;
  readonly container: ContainerKind;
  /** Absent when Pass A declared nothing for it: a statement, walked whole in `$root`. */
  readonly declared?: Declared;
}

/** Everything Pass A learned that Pass B needs. */
export interface PassBInput {
  readonly request: ExtractRequest;
  readonly adapter: LanguageAdapter;
  /** The MODULE's id (`$root`). */
  readonly moduleId: string;
  readonly children: readonly ContainerChild[];
}

interface Region {
  readonly scope: readonly [string, ...string[]];
  readonly enclosing: { readonly label: 'METHOD' | 'MODULE'; readonly id: string };
  readonly params: readonly Binding[];
  /** The module MEMBERs declared before this region, in source order. */
  readonly members: readonly Binding[];
  readonly shadow: ReadonlySet<string>;
}

function nodeRange(node: SyntaxNode): SourceRange {
  return {
    startRow: node.startPosition.row,
    startColumn: node.startPosition.column,
    endRow: node.endPosition.row,
    endColumn: node.endPosition.column,
  };
}

const position = (node: SyntaxNode) => ({
  row: node.startPosition.row,
  column: node.startPosition.column,
});

/**
 * Runs only when Pass A finished the whole file (I21): walkFile does not call it after a budget hit, so a
 * truncated file has no CALL, no Pass B edge and no ref site. Pass B does not count toward
 * `astNodesVisited` or the budget (they stay Pass A's container children, as walk.ts states).
 *
 * Regions and ordinals (controller decision 92, the schema's ordinal_rule): a CALL's region is its
 * enclosing METHOD, or `$root` when no METHOD encloses it. Every CALL in the region counts, in pre-order
 * (a call before the calls inside it, its callee's included, then source order). The CALL id is
 * `makeNodeId({ form: 'scoped', path, kind: 'CALL', scope, ordinal })` with scope the METHOD's id scope
 * (`main`, `Box.grow`) or `['$root']`, and one counter per scope: a repeated METHOD (`K.m` and `K.m:1`,
 * a property's getter and setter) continues its scope's count in source order, so I7 holds. So:
 * - a METHOD's body is its region; a nested `def`/`class` in it (and its decorators) is never descended
 *   (decision 92); a `lambda` is transparent (its calls are its METHOD's);
 * - `$root` holds, in source order: the module and class-body statements Pass A did not declare (walked
 *   whole), MEMBER initializers (module- or class-level), and the decorators of every declaration at
 *   module or class level. An ERROR node is not descended anywhere (decision 95). Parameters' defaults,
 *   annotations and class bases are not walked in v1.
 * - a decorator CALL's walk continues into its arguments only (python.ts); any other CALL's into all
 *   its named children.
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
 *   scheme, package }`, kept once by the builder) and CALLS `{ status: 'external' }` to it;
 * - else nothing: no edge and no SYMBOL (no bare-name SYMBOL for what was not attributed). A receiver
 *   call (`self.f()`, `g.greet()`) never gets CALLS here, whatever its name.
 *
 * Ref sites (C-EXTRACT RefSite; I12, I20), all with `filePath` the path and `nodeId` the CALL's id; ids
 * unique within the file (archive refSites.ts: the CALL id, `<id>#recv`, `<id>#type`):
 * - one `call` site per CALL with a `nameNode`: position its start (the LAST callee segment, I20),
 *   nameParts the CallInfo's; no `declined` (the extractor does not know it will not resolve);
 * - when `receiverNode` is set, a `receiver` and a `receiver-type` site: position the start of
 *   receiverNode, nameParts the call's minus its last segment, `declined: 'receiver-unknown'` (v1
 *   answers none, so the gap is counted).
 *
 * REACHING_DEF (archive resolveArg; "last match wins"): for each arg with an `identifier`, unless the
 * region's `adapter.localBindings` (of the METHOD body; in `$root`, of the statement or the initializer)
 * names it: from the region METHOD's PARAM of that name; else from the LAST module-level MEMBER of that
 * name declared before the region (the METHOD, or the `$root` statement); else nothing. Properties
 * `{ variable }`; one edge per (source, CALL, variable).
 */
export function walkCalls(input: PassBInput, builder: ElementBuilder): void {
  const { request, adapter, moduleId, children } = input;
  const { path, revision_id } = request;

  const targets = new Map<string, string>();
  for (const { container, declared } of children) {
    const info = declared?.info;
    if (container !== 'MODULE' || info === undefined || info.declares === 'MEMBER') continue;
    const kind = info.declares === 'METHOD' ? 'method' : 'type';
    const descriptors = [{ kind, name: info.name }] as const;
    targets.set(info.name, makeSymbolFqn({ form: 'local', path, descriptors }));
  }

  const ordinals = new Map<string, number>();

  function callsTarget(
    info: CallInfo,
  ): { fqn: string; status: 'resolved' | 'external' } | undefined {
    if (info.receiverText !== undefined) return undefined;
    const local = targets.get(info.calleeName);
    if (local !== undefined) return { fqn: local, status: 'resolved' };
    const { builtin } = info;
    if (builtin === undefined) return undefined;
    const fqn = makeSymbolFqn({ form: 'external', ...builtin });
    builder.addSymbol({
      fqn,
      origin: 'builtin',
      language: adapter.language,
      properties: { kind: 'function', scheme: builtin.scheme, package: builtin.package },
    });
    return { fqn, status: 'external' };
  }

  function emitCall(node: SyntaxNode, info: CallInfo, region: Region): void {
    const base = makeNodeId({ form: 'scoped', path, kind: 'CALL', scope: region.scope });
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    const id = makeNodeId({ form: 'scoped', path, kind: 'CALL', scope: region.scope, ordinal });
    const callRef = { by: 'id', label: 'CALL', key: id } as const;

    builder.addNode({
      label: 'CALL',
      id,
      file: path,
      revision_id,
      tier: 'structural',
      range: nodeRange(node),
      properties: {
        callee_name: info.calleeName,
        ...(info.receiverText !== undefined ? { receiver_text: info.receiverText } : {}),
        args_count: info.args.length,
        kind: info.kind,
        status: 'ready',
      },
    });
    builder.addEdge({
      type: 'IN_SCOPE',
      from: callRef,
      to: { by: 'id', label: region.enclosing.label, key: region.enclosing.id },
      properties: {},
    });

    const target = callsTarget(info);
    if (target !== undefined) {
      builder.addEdge({
        type: 'CALLS',
        from: callRef,
        to: { by: 'fqn', label: 'SYMBOL', key: target.fqn },
        properties: { status: target.status },
      });
    }

    if (info.nameNode !== undefined) {
      builder.addRefSite({
        id,
        nodeId: id,
        filePath: path,
        kind: 'call',
        position: position(info.nameNode),
        nameParts: info.nameParts,
      });
    }
    if (info.receiverNode !== undefined) {
      const receiver = {
        nodeId: id,
        filePath: path,
        position: position(info.receiverNode),
        nameParts: info.nameParts.slice(0, -1),
        declined: 'receiver-unknown',
      } as const;
      builder.addRefSite({ ...receiver, id: `${id}#recv`, kind: 'receiver' });
      builder.addRefSite({ ...receiver, id: `${id}#type`, kind: 'receiver-type' });
    }

    const reached = new Set<string>();
    for (const { identifier } of info.args) {
      if (identifier === undefined || region.shadow.has(identifier)) continue;
      const param = region.params.find((b) => b.name === identifier);
      const member = region.members.findLast((b) => b.name === identifier);
      const source = param ?? member;
      if (source === undefined || reached.has(`${source.id} ${identifier}`)) continue;
      reached.add(`${source.id} ${identifier}`);
      builder.addEdge({
        type: 'REACHING_DEF',
        from: { by: 'id', label: param !== undefined ? 'PARAM' : 'MEMBER', key: source.id },
        to: callRef,
        properties: { variable: identifier },
      });
    }
  }

  function visit(node: SyntaxNode, region: Region): void {
    if (node.type === 'ERROR') return;
    const verdict = adapter.classifyExpression?.(node);
    if (verdict?.emits === 'CALL') {
      emitCall(node, verdict, region);
      const next =
        verdict.kind === 'decorator' ? verdict.args.map((a) => a.node) : node.namedChildren;
      for (const child of next) visit(child, region);
      return;
    }
    if (verdict?.descend === 'stop') return;
    for (const child of node.namedChildren) visit(child, region);
  }

  const members: Binding[] = [];
  const shadowOf = (root: SyntaxNode | undefined): ReadonlySet<string> =>
    new Set(root === undefined ? [] : (adapter.localBindings?.(root) ?? []));
  const inRoot = (root: SyntaxNode | undefined): Region => ({
    scope: [MODULE_SCOPE],
    enclosing: { label: 'MODULE', id: moduleId },
    params: [],
    members,
    shadow: shadowOf(root),
  });

  for (const { node, container, declared } of children) {
    if (declared === undefined) {
      visit(node, inRoot(node));
      continue;
    }
    const { info } = declared;
    if (info.declares === 'MEMBER') {
      if (info.value !== undefined) visit(info.value, inRoot(info.value));
      if (container === 'MODULE') members.push({ name: info.name, id: declared.id });
      continue;
    }
    for (const part of node.namedChildren) {
      const verdict = adapter.classifyExpression?.(part);
      if (verdict?.emits === 'CALL' && verdict.kind === 'decorator') visit(part, inRoot(undefined));
    }
    if (info.declares === 'METHOD' && info.body !== undefined) {
      visit(info.body, {
        scope: declared.scope,
        enclosing: { label: 'METHOD', id: declared.id },
        params: declared.params,
        members,
        shadow: shadowOf(info.body),
      });
    }
  }
}
