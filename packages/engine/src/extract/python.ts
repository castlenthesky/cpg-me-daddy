/**
 * The Python declaration and call adapter (M0.8's declarations slice,
 * extended by M0.9 with calls/SYMBOLs/data flow).
 *
 * Node-type shapes below were verified empirically against the pinned
 * `web-tree-sitter` + `@vscode/tree-sitter-wasm` grammar (see the field
 * tables in this file's PR description) rather than assumed from the
 * grammar's docs, which drift across versions.
 *
 * Deliberately NOT handled in this slice (classify() returns `undefined`,
 * or a case is simply absent) — each is a documented, later gap, not an
 * oversight: `decorated_definition` (decorators — `@dataclass`, `@property`
 * getters/setters, `@staticmethod`) — undecorated today, so a decorated
 * function is invisible as a declaration AND (M0.9) as a call region;
 * `*args`/`**kwargs` (best-effort name only, no splat marker property yet);
 * tuple-unpacking or attribute assignment as a MEMBER target; `__all__`-
 * based export control.
 *
 * `classifyExpression` (M0.9) mirrors `./typescript.ts`'s narrowness:
 * `call` is minted as CALL; `lambda` is transparent (a single-expression
 * inline callback, not itself declared); a nested NAMED `function_
 * definition`/`class_definition` is a hard stop. Receiver-qualified calls
 * are attributed only for `self.foo()` (`local-this`) — a stdlib
 * module-qualified call (`os.path.join(...)`) is NOT attributed in this
 * slice (no module-name table exists yet), unlike TS's bare-global table;
 * only BARE Python builtins (`print`, `len`, …) resolve.
 */
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
import { PYTHON_BUILTIN_NAMES } from "./builtins/python-stdlib";
import type { SyntaxNode } from "./syntax";

/** Strips a Python string literal's quote delimiters (incl. triple-quoted, `f`/`r`/`b` prefixed). */
function stripStringQuotes(text: string): string {
  const match = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(text);
  return match ? match[2]! : text;
}

/** First non-blank line of a docstring, trimmed. `undefined` if the string is empty/whitespace. */
function docstringHead(text: string): string | undefined {
  const body = stripStringQuotes(text).trim();
  if (body === "") {
    return undefined;
  }
  return body.split("\n")[0]!.trim();
}

/** The bare string literal a module/class/function body opens with, if any — its docstring. */
function leadingDocstring(body: SyntaxNode | null): string | undefined {
  const first = body?.namedChildren[0];
  if (first?.type !== "expression_statement") {
    return undefined;
  }
  const inner = first.namedChildren[0];
  if (inner?.type !== "string") {
    return undefined;
  }
  return docstringHead(inner.text);
}

function isExported(name: string): boolean {
  return !name.startsWith("_");
}

function paramInfo(node: SyntaxNode): ParamInfo | undefined {
  switch (node.type) {
    case "identifier":
      return { name: node.text, node };
    case "typed_parameter": {
      const name = node.namedChildren.find((c) => c.type === "identifier")?.text;
      if (name === undefined) {
        return undefined;
      }
      return { name, node, typeText: node.childForFieldName("type")?.text };
    }
    case "default_parameter": {
      const name = node.childForFieldName("name")?.text;
      if (name === undefined) {
        return undefined;
      }
      return { name, node, defaultText: node.childForFieldName("value")?.text };
    }
    case "typed_default_parameter": {
      const name = node.childForFieldName("name")?.text;
      if (name === undefined) {
        return undefined;
      }
      return {
        name,
        node,
        typeText: node.childForFieldName("type")?.text,
        defaultText: node.childForFieldName("value")?.text,
      };
    }
    case "list_splat_pattern":
      return { name: node.text.replace(/^\*/, ""), node };
    case "dictionary_splat_pattern":
      return { name: node.text.replace(/^\*\*/, ""), node };
    default:
      return undefined;
  }
}

function classifyFunction(node: SyntaxNode, isMethodOfClass: boolean): MethodInfo | undefined {
  const name = node.childForFieldName("name")?.text;
  const paramsNode = node.childForFieldName("parameters");
  if (name === undefined || paramsNode === null || paramsNode === undefined) {
    return undefined;
  }
  const params = paramsNode.namedChildren
    .map((p) => paramInfo(p))
    .filter((p): p is ParamInfo => p !== undefined);

  const returnType = node.childForFieldName("return_type")?.text;
  const signature = `${name}(${params
    .map((p) => (p.typeText !== undefined ? `${p.name}: ${p.typeText}` : p.name))
    .join(", ")})${returnType !== undefined ? ` -> ${returnType}` : ""}`;

  const async = node.text.trimStart().startsWith("async ");
  const kind = isMethodOfClass ? (name === "__init__" ? "constructor" : "method") : "function";

  return {
    declares: "METHOD",
    name,
    kind,
    signature,
    exported: isExported(name),
    async,
    docstringHead: leadingDocstring(node.childForFieldName("body")),
    params,
    body: node.childForFieldName("body") ?? undefined,
  };
}

function classifyClass(node: SyntaxNode): TypeDeclInfo | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) {
    return undefined;
  }
  const body = node.childForFieldName("body") ?? undefined;
  return {
    declares: "TYPE_DECL",
    name,
    kind: "class",
    exported: isExported(name),
    structural: true,
    docstringHead: leadingDocstring(body ?? null),
    body,
  };
}

/** `NAME = value` or `NAME: Type = value`, at module or class level, as a MEMBER. */
function classifyAssignment(node: SyntaxNode): MemberInfo | undefined {
  const inner = node.namedChildren[0];
  if (inner?.type !== "assignment") {
    return undefined;
  }
  const left = inner.childForFieldName("left");
  if (left?.type !== "identifier") {
    return undefined; // Attribute assignment (`self.x = ...`), tuple unpacking, etc — not a MEMBER here.
  }
  return {
    declares: "MEMBER",
    name: left.text,
    typeText: inner.childForFieldName("type")?.text,
    value: inner.childForFieldName("right") ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Pass B: calls (M0.9).
// ---------------------------------------------------------------------------

const TRANSPARENT_TYPES = new Set(["lambda"]);
const STOP_TYPES = new Set(["function_definition", "class_definition"]);

interface CalleeShape {
  readonly calleeName: string;
  readonly receiverText?: string;
  readonly receiverNode?: SyntaxNode;
}

/** `identifier` (bare) or `attribute` (`object.attribute`) — the two callee shapes this slice attributes. */
function calleeShape(fn: SyntaxNode): CalleeShape | undefined {
  if (fn.type === "identifier") {
    return { calleeName: fn.text };
  }
  if (fn.type === "attribute") {
    const object = fn.childForFieldName("object");
    const attribute = fn.childForFieldName("attribute");
    if (object === null || attribute?.type !== "identifier") {
      return undefined;
    }
    return { calleeName: attribute.text, receiverText: object.text, receiverNode: object };
  }
  return undefined; // A subscript/call/parenthesized callee — no stable name.
}

function attributeCallee(shape: CalleeShape): CalleeAttribution {
  if (shape.receiverNode === undefined) {
    const fallback: BuiltinTarget | undefined = PYTHON_BUILTIN_NAMES.has(shape.calleeName)
      ? {
          scheme: "site",
          package: "python-stdlib",
          segments: [{ kind: "method", name: shape.calleeName }],
        }
      : undefined;
    return { kind: "local-name", name: shape.calleeName, fallback };
  }
  // Python's `self` is a plain bound identifier, not its own node type
  // (unlike TS's `this`) — the receiver text IS the check.
  if (shape.receiverNode.type === "identifier" && shape.receiverNode.text === "self") {
    return { kind: "local-this", name: shape.calleeName };
  }
  // No stdlib-module-name table exists yet — `os.path.join(...)`-shaped
  // calls are unattributed in this slice, unlike TS's bare-global table.
  return { kind: "none" };
}

/** A Python `keyword_argument` unwraps to its own `value` field; everything else is checked as-is. */
function argInfoFor(node: SyntaxNode): ArgInfo {
  if (node.type === "keyword_argument") {
    const value = node.childForFieldName("value");
    return { node, identifier: value?.type === "identifier" ? value.text : undefined };
  }
  return { node, identifier: node.type === "identifier" ? node.text : undefined };
}

function argInfos(argumentsNode: SyntaxNode | null): readonly ArgInfo[] {
  return (argumentsNode?.namedChildren ?? []).map(argInfoFor);
}

function classifyCall(node: SyntaxNode): ExpressionVerdict | undefined {
  const fn = node.childForFieldName("function");
  if (fn === null) {
    return undefined;
  }
  const shape = calleeShape(fn);
  if (shape === undefined) {
    return undefined;
  }
  return {
    emits: "CALL",
    kind: "call",
    calleeName: shape.calleeName,
    receiverText: shape.receiverText,
    args: argInfos(node.childForFieldName("arguments")),
    callee: attributeCallee(shape),
  };
}

function classifyExpressionPy(node: SyntaxNode): ExpressionVerdict | undefined {
  switch (node.type) {
    case "call":
      return classifyCall(node);
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

/**
 * Every name a region's own body binds locally via a plain `NAME = value`
 * assignment — shadows an outer MEMBER/PARAM of the same name for
 * REACHING_DEF. `for`/`with`/`except` binders are a known, documented gap
 * (matching `./typescript.ts`'s equivalent scope).
 */
function localBindingsPy(regionRoot: SyntaxNode): readonly string[] {
  const names: string[] = [];
  function visit(node: SyntaxNode): void {
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left?.type === "identifier") {
        names.push(left.text);
      }
      return; // The RHS is walked separately, by Pass B's own descent.
    }
    if (TRANSPARENT_TYPES.has(node.type) || STOP_TYPES.has(node.type)) {
      return; // A nested function's own locals are that region's own concern, not this one's.
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }
  visit(regionRoot);
  return names;
}

export const pythonAdapter: LanguageAdapter = {
  grammarId: "python",
  language: "python",
  moduleRootType: "module",
  moduleName(path: string): string {
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.py$/, "");
  },
  classify(node: SyntaxNode, container: ContainerKind): DeclarationInfo | undefined {
    switch (node.type) {
      case "function_definition":
        return classifyFunction(node, container === "TYPE_DECL");
      case "class_definition":
        return classifyClass(node);
      case "expression_statement":
        return classifyAssignment(node);
      default:
        return undefined;
    }
  },
  classifyExpression: classifyExpressionPy,
  localBindings: localBindingsPy,
};
