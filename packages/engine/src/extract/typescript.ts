/**
 * The TypeScript/JS declaration and call adapter (M0.6's declarations
 * slice, extended by M0.7 with calls/SYMBOLs/data flow). Node-type shapes
 * verified empirically against the pinned grammar, the same way as
 * `./python.ts`.
 *
 * Deliberately NOT handled in this slice (classify() returns `undefined`,
 * or a case is simply absent) — each a documented, later gap: `interface_
 * declaration`, `type_alias_declaration`, `enum_declaration` (TYPE_DECL_KIND
 * supports them; this adapter doesn't emit them yet — untested field
 * shapes, no fixture needs them); `export default`; getter/setter or async
 * detection when other modifiers precede them (`static async`, `public
 * get`); a `lexical_declaration`/`variable_declaration` with more than one
 * declarator (`const a = 1, b = 2`) — silently skipped, not split into
 * multiple MEMBERs; parameter destructuring patterns; decorators.
 *
 * Docstrings: TypeScript's `/** ... *\/` is a sibling `comment` node, not
 * part of the declaration's own subtree the way Python's docstring is the
 * first statement in a body — extracting it needs the PRECEDING sibling,
 * which `walk.ts`'s per-child classify call doesn't have access to. Left
 * for a later unit; `docstring_head` is `zeroOrOne` so this is a silent,
 * legal omission, not a schema violation.
 *
 * `classifyExpression` (M0.7) is deliberately narrow: `call_expression`/
 * `new_expression` are minted as CALL; `arrow_function`/`function_
 * expression`/generator variants are transparent (an inline callback is
 * not itself declared — `IN_SCOPE`'s own rationale); a nested NAMED
 * function/class is a hard stop (walk.ts's frame-uniqueness invariant
 * depends on it). Not handled: tagged templates (no `arguments` field, so
 * `args_count` degrades to 0 rather than throwing — undocumented as a
 * fixture case, not a crash); a computed/parenthesized callee
 * (`obj[key]()`, `(await f())()`) — `CALL.callee_name` is required, so
 * these sites are skipped entirely, never emitted with a fabricated name;
 * decorator calls (still unclassified as declarations too); `await`/kind
 * detection (an `await_expression` isn't itself classified, so the inner
 * `call_expression` is found by ordinary descent and always mints
 * `kind: "call"`, never `"await"`).
 */
import type { GrammarId } from "../parser/grammars";
import type {
  ArgInfo,
  BuiltinTarget,
  CalleeAttribution,
  ContainerKind,
  DeclarationInfo,
  ExpressionVerdict,
  LanguageAdapter,
  MemberInfo,
  MethodInfo,
  ParamInfo,
  TypeDeclInfo,
} from "./adapter";
import { NODE_GLOBAL_NAMES } from "./builtins/node-globals";
import type { SyntaxNode } from "./syntax";

function stripTypeAnnotation(text: string | undefined): string | undefined {
  return text?.replace(/^:\s*/, "");
}

function paramInfo(node: SyntaxNode): ParamInfo | undefined {
  if (node.type === "identifier") {
    return { name: node.text, node };
  }
  // required_parameter / optional_parameter / rest_parameter all use
  // `pattern` (the binding identifier) + optional `type` + optional `value`.
  const pattern = node.childForFieldName("pattern");
  const name = pattern?.type === "identifier" ? pattern.text : undefined;
  if (name === undefined) {
    return undefined; // Destructuring pattern — deferred.
  }
  return {
    name,
    node,
    typeText: stripTypeAnnotation(node.childForFieldName("type")?.text),
    defaultText: node.childForFieldName("value")?.text,
  };
}

function classifyFunctionLike(
  node: SyntaxNode,
  name: string,
  kind: MethodInfo["kind"],
  exported: boolean,
): MethodInfo {
  const paramsNode = node.childForFieldName("parameters");
  const params = (paramsNode?.namedChildren ?? [])
    .map((p) => paramInfo(p))
    .filter((p): p is ParamInfo => p !== undefined);

  const returnType = stripTypeAnnotation(node.childForFieldName("return_type")?.text);
  const signature = `${name}(${params
    .map((p) => (p.typeText !== undefined ? `${p.name}: ${p.typeText}` : p.name))
    .join(", ")})${returnType !== undefined ? `: ${returnType}` : ""}`;

  return {
    declares: "METHOD",
    name,
    kind,
    signature,
    exported,
    async: node.text.trimStart().startsWith("async "),
    params,
    body: node.childForFieldName("body") ?? undefined,
  };
}

function classifyFunctionDeclaration(node: SyntaxNode, exported: boolean): MethodInfo | undefined {
  const name = node.childForFieldName("name")?.text;
  return name === undefined ? undefined : classifyFunctionLike(node, name, "function", exported);
}

/** Always `exported: false` — class-body members have no `export` keyword of their own. */
function classifyMethodDefinition(node: SyntaxNode): MethodInfo | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) {
    return undefined;
  }
  const trimmed = node.text.trimStart();
  const kind: MethodInfo["kind"] =
    name === "constructor"
      ? "constructor"
      : trimmed.startsWith("get ")
        ? "getter"
        : trimmed.startsWith("set ")
          ? "setter"
          : "method";
  return classifyFunctionLike(node, name, kind, false);
}

function classifyClassDeclaration(node: SyntaxNode, exported: boolean): TypeDeclInfo | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) {
    return undefined;
  }
  return {
    declares: "TYPE_DECL",
    name,
    kind: "class",
    exported,
    structural: true,
    body: node.childForFieldName("body") ?? undefined,
  };
}

function classifyFieldDefinition(node: SyntaxNode): MemberInfo | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) {
    return undefined;
  }
  return {
    declares: "MEMBER",
    name,
    typeText: stripTypeAnnotation(node.childForFieldName("type")?.text),
    value: node.childForFieldName("value") ?? undefined,
  };
}

/** `const`/`let`/`var` with exactly one declarator, as a MEMBER. Multi-declarator statements are skipped. */
function classifyVariableStatement(node: SyntaxNode): MemberInfo | undefined {
  const declarators = node.namedChildren.filter((c) => c.type === "variable_declarator");
  if (declarators.length !== 1) {
    return undefined;
  }
  const declarator = declarators[0]!;
  const name = declarator.childForFieldName("name")?.text;
  if (name === undefined) {
    return undefined;
  }
  return {
    declares: "MEMBER",
    name,
    typeText: stripTypeAnnotation(declarator.childForFieldName("type")?.text),
    value: declarator.childForFieldName("value") ?? undefined,
  };
}

function classifyInner(
  node: SyntaxNode,
  container: ContainerKind,
  exported: boolean,
): DeclarationInfo | undefined {
  switch (node.type) {
    case "function_declaration":
      return classifyFunctionDeclaration(node, exported);
    case "class_declaration":
      return classifyClassDeclaration(node, exported);
    case "method_definition":
      return container === "TYPE_DECL" ? classifyMethodDefinition(node) : undefined;
    case "public_field_definition":
      return container === "TYPE_DECL" ? classifyFieldDefinition(node) : undefined;
    case "lexical_declaration":
    case "variable_declaration":
      return classifyVariableStatement(node);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pass B: calls (M0.7).
// ---------------------------------------------------------------------------

const TRANSPARENT_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
]);

const STOP_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "class",
  "method_definition",
]);

interface CalleeShape {
  readonly calleeName: string;
  readonly receiverText?: string;
  readonly receiverNode?: SyntaxNode;
}

/** `identifier` (bare) or `member_expression` (`object.property`) — the two callee shapes this slice attributes. */
function calleeShape(fn: SyntaxNode): CalleeShape | undefined {
  if (fn.type === "identifier") {
    return { calleeName: fn.text };
  }
  if (fn.type === "member_expression") {
    const object = fn.childForFieldName("object");
    const property = fn.childForFieldName("property");
    if (object === null || property?.type !== "property_identifier") {
      return undefined; // Computed member access (`obj[key]`) — no stable name.
    }
    return { calleeName: property.text, receiverText: object.text, receiverNode: object };
  }
  return undefined; // A parenthesized/computed callee — CALL.callee_name is required, so skip the site.
}

function attributeCallee(shape: CalleeShape): CalleeAttribution {
  if (shape.receiverNode === undefined) {
    const fallback: BuiltinTarget | undefined = NODE_GLOBAL_NAMES.has(shape.calleeName)
      ? { scheme: "site", package: "node", segments: [{ kind: "method", name: shape.calleeName }] }
      : undefined;
    return { kind: "local-name", name: shape.calleeName, fallback };
  }
  if (shape.receiverNode.type === "this") {
    return { kind: "local-this", name: shape.calleeName };
  }
  if (shape.receiverNode.type === "identifier" && NODE_GLOBAL_NAMES.has(shape.receiverNode.text)) {
    return {
      kind: "builtin",
      scheme: "site",
      package: "node",
      segments: [
        { kind: "term", name: shape.receiverNode.text },
        { kind: "method", name: shape.calleeName },
      ],
    };
  }
  return { kind: "none" };
}

/** `arguments`' own named children — `identifier` is the only bare-name-reference shape this slice matches. */
function argInfos(argumentsNode: SyntaxNode | null): readonly ArgInfo[] {
  return (argumentsNode?.namedChildren ?? []).map((node) => ({
    node,
    identifier: node.type === "identifier" ? node.text : undefined,
  }));
}

function classifyCall(node: SyntaxNode, kind: "call" | "new"): ExpressionVerdict | undefined {
  const fn =
    kind === "call" ? node.childForFieldName("function") : node.childForFieldName("constructor");
  if (fn === null) {
    return undefined;
  }
  const shape = calleeShape(fn);
  if (shape === undefined) {
    return undefined;
  }
  return {
    emits: "CALL",
    kind,
    calleeName: shape.calleeName,
    receiverText: shape.receiverText,
    args: argInfos(node.childForFieldName("arguments")),
    callee: attributeCallee(shape),
  };
}

function classifyExpressionTs(node: SyntaxNode): ExpressionVerdict | undefined {
  switch (node.type) {
    case "call_expression":
      return classifyCall(node, "call");
    case "new_expression":
      return classifyCall(node, "new");
    default:
      if (TRANSPARENT_TYPES.has(node.type)) {
        return { emits: "none", descend: "transparent" };
      }
      if (STOP_TYPES.has(node.type)) {
        return { emits: "none", descend: "stop" };
      }
      return undefined;
  }
}

/** Every name a region's own body binds locally — shadows an outer MEMBER/PARAM of the same name for REACHING_DEF. */
function localBindingsTs(regionRoot: SyntaxNode): readonly string[] {
  const names: string[] = [];
  function visit(node: SyntaxNode): void {
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") {
        names.push(name.text);
      }
      return; // Don't descend into its own initializer here — Pass B walks it separately.
    }
    if (TRANSPARENT_TYPES.has(node.type) || STOP_TYPES.has(node.type)) {
      return; // A nested function's own params/locals are that region's own concern, not this one's.
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }
  visit(regionRoot);
  return names;
}

/**
 * Builds the adapter for either the `typescript` or the `tsx` grammar. A
 * factory, not a single shared object with the `grammarId` swapped after the
 * fact: the tsx and typescript grammars are generated from the same
 * `grammar.js` and emit identical node type names for everything this
 * adapter classifies (`class_declaration`, `method_definition`,
 * `public_field_definition`, …) plus JSX-only ones this adapter simply never
 * matches — so the classification logic is genuinely shared, not
 * approximated. `extractFile` calls `backend.parse(adapter.grammarId, text)`,
 * so the id must actually be `"tsx"` for a `.tsx` file or it gets parsed by
 * the TypeScript grammar and yields an ERROR tree (see `grammars.ts`'s module
 * doc on why the two are not interchangeable).
 */
export function makeTypeScriptAdapter(
  grammarId: Extract<GrammarId, "typescript" | "tsx">,
): LanguageAdapter {
  return {
    grammarId,
    // Both grammar ids report the same SYMBOL language — `.tsx` is a
    // syntax variant of TypeScript, not a distinct symbol space.
    language: "typescript",
    moduleRootType: "program",
    moduleName(path: string): string {
      const base = path.split("/").pop() ?? path;
      return base.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "");
    },
    classify(node: SyntaxNode, container: ContainerKind): DeclarationInfo | undefined {
      if (node.type === "export_statement") {
        const inner = node.childForFieldName("declaration");
        if (inner === null || inner === undefined) {
          return undefined; // `export { x }` / `export default expr` — deferred.
        }
        return classifyInner(inner, container, true);
      }
      return classifyInner(node, container, false);
    },
    classifyExpression: classifyExpressionTs,
    localBindings: localBindingsTs,
  };
}

export const typeScriptAdapter: LanguageAdapter = makeTypeScriptAdapter("typescript");
export const tsxAdapter: LanguageAdapter = makeTypeScriptAdapter("tsx");
