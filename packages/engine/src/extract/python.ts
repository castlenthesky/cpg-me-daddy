/**
 * The Python declaration adapter (M0.8's declarations slice).
 *
 * Node-type shapes below were verified empirically against the pinned
 * `web-tree-sitter` + `@vscode/tree-sitter-wasm` grammar (see the field
 * tables in this file's PR description) rather than assumed from the
 * grammar's docs, which drift across versions.
 *
 * Deliberately NOT handled in this slice (classify() returns `undefined`,
 * or a case is simply absent) — each is a documented, later gap, not an
 * oversight: `decorated_definition` (decorators — `@dataclass`, `@property`
 * getters/setters, `@staticmethod`); `*args`/`**kwargs` (best-effort name
 * only, no splat marker property yet); tuple-unpacking or attribute
 * assignment as a MEMBER target; `__all__`-based export control.
 */
import type {
  ContainerKind,
  DeclarationInfo,
  LanguageAdapter,
  MemberInfo,
  MethodInfo,
  ParamInfo,
  TypeDeclInfo,
} from "./adapter";
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
  };
}

export const pythonAdapter: LanguageAdapter = {
  grammarId: "python",
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
};
