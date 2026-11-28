// The Python adapter: the MODULE tier (U6a.2-2) and the declaration half (U6a.2-3), ported from archive
// f18ee71:packages/engine/src/extract/python.ts (classifyFunction, classifyClass, classifyAssignment,
// paramInfo, the docstring helpers), plus `decorated_definition` (decision 107). The expression half
// (Pass B calls, U6a.2-4a) from classifyExpressionPy, calleeShape, argInfos and localBindingsPy, with
// resolveCallee's attribution REMOVED: a call is syntax, plus the builtin table's answer. IMPORT is
// BMO-134, declared-not-emitted in the coverage table until then, never silent (I13).

import type { WorkspacePath } from '@cpg/model';
import type {
  ArgInfo,
  BuiltinTarget,
  CallInfo,
  CallKind,
  ContainerKind,
  CoverageManifest,
  DeclarationInfo,
  Disposition,
  ExpressionVerdict,
  LanguageAdapter,
  MemberInfo,
  MethodInfo,
  ParamInfo,
  SyntaxNode,
  TypeDeclInfo,
} from './contract';
import { EXTRACT_CONTRACT_VERSION } from './version';

const emits = (...fromNodeTypes: readonly string[]): Disposition =>
  Object.freeze({ state: 'emits', fromNodeTypes: Object.freeze([...fromNodeTypes]) });

const notMine = (
  owner: 'filesystem-tier' | 'resolve-pass' | 'analysis-pass' | 'meta',
): Disposition => Object.freeze({ state: 'not-mine', owner });

const later = (reason: string, trackingId: string): Disposition =>
  Object.freeze({ state: 'declared-not-emitted', reason, trackingId });

const PYTHON_COVERAGE: CoverageManifest = Object.freeze({
  contractVersion: EXTRACT_CONTRACT_VERSION,
  grammarId: 'python',
  nodes: Object.freeze({
    DIRECTORY: notMine('filesystem-tier'),
    FILE: notMine('filesystem-tier'),
    MODULE: emits('module'),
    TYPE_DECL: emits('class_definition', 'decorated_definition'),
    METHOD: emits('function_definition', 'decorated_definition'),
    PARAM: emits(
      'identifier',
      'typed_parameter',
      'default_parameter',
      'typed_default_parameter',
      'list_splat_pattern',
      'dictionary_splat_pattern',
    ),
    MEMBER: emits('expression_statement'),
    CALL: emits('call', 'decorator'),
    IMPORT: later('Pass B imports land in U6a.2-4b', 'BMO-134'),
    SYMBOL: emits(
      'module',
      'class_definition',
      'function_definition',
      'expression_statement',
      'decorated_definition',
      'call',
      'decorator',
    ),
    COMMUNITY: notMine('analysis-pass'),
    TAG: notMine('meta'),
    UNKNOWN: emits('ERROR'),
    META_DATA: notMine('meta'),
  }),
  edges: Object.freeze({
    HAS_ENTRY: notMine('filesystem-tier'),
    DECLARES: emits(
      'class_definition',
      'function_definition',
      'expression_statement',
      'decorated_definition',
    ),
    HAS_PARAM: emits('function_definition', 'decorated_definition'),
    DEFINES: emits(
      'module',
      'class_definition',
      'function_definition',
      'expression_statement',
      'decorated_definition',
    ),
    CALLS: emits('call', 'decorator'),
    IN_SCOPE: emits('call', 'decorator'),
    IMPORTS: notMine('resolve-pass'),
    INHERITS_FROM: later(
      'per-file inheritance with a SYMBOL endpoint; no unit scheduled',
      'C-EXTRACT Q3',
    ),
    MEMBER_OF: notMine('analysis-pass'),
    ALIAS_OF: notMine('resolve-pass'),
    TAGGED_BY: notMine('meta'),
    TARGETS: notMine('analysis-pass'),
    DEPENDS_ON: notMine('analysis-pass'),
    REACHING_DEF: emits('call', 'decorator'),
    SOURCE_FILE: notMine('filesystem-tier'),
  }),
});

/**
 * The dotted module name from the workspace root (rung 07): the `.py` suffix is dropped from the last
 * segment, case-insensitively (C-PARSE routes `SCRIPT.PY` to python); a last segment of `__init__`
 * is dropped too, naming its package, except at the workspace root, where it stays `__init__`;
 * the segments are joined with `.`. `main.py` -> `main`, `shapes/square.py` -> `shapes.square`,
 * `shapes/__init__.py` -> `shapes`. Source roots (`src/`) are the resolver's concern (U6c), not this.
 */
function moduleName(path: WorkspacePath): string {
  const segments = path.split('/');
  const last = segments.at(-1);
  if (last === undefined) return path;
  const stem = last.replace(/\.py$/i, '');
  segments[segments.length - 1] = stem;
  if (segments.length > 1 && stem === '__init__') {
    segments.pop();
  }
  return segments.join('.');
}

/** Strips a Python string literal's prefix letters and matching quote delimiters. */
function stripStringQuotes(text: string): string {
  const match = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(text);
  return match?.[2] ?? text;
}

/** First non-blank line of a docstring, trimmed. `undefined` when empty or whitespace-only. */
function docstringHead(text: string): string | undefined {
  const body = stripStringQuotes(text).trim();
  if (body === '') return undefined;
  const newline = body.indexOf('\n');
  return (newline === -1 ? body : body.slice(0, newline)).trim();
}

/** The bare string literal a class or function body opens with, if any — its docstring. */
function leadingDocstring(body: SyntaxNode | null): string | undefined {
  const first = body?.namedChildren[0];
  if (first?.type !== 'expression_statement') return undefined;
  const inner = first.namedChildren[0];
  if (inner?.type !== 'string') return undefined;
  return docstringHead(inner.text);
}

function isExported(name: string): boolean {
  return !name.startsWith('_');
}

/** Extracts the parameter identifier name from an identifier or a splat pattern. */
function paramName(node: SyntaxNode | null | undefined): string | undefined {
  if (node?.type === 'identifier') return node.text;
  if (node?.type === 'list_splat_pattern' || node?.type === 'dictionary_splat_pattern') {
    return node.namedChildren.find((child) => child.type === 'identifier')?.text;
  }
  return undefined;
}

function buildParam(
  name: string | undefined,
  node: SyntaxNode,
  typeText?: string,
  defaultText?: string,
): Omit<ParamInfo, 'ordinal'> | undefined {
  if (name === undefined) return undefined;
  return {
    name,
    node,
    ...(typeText !== undefined ? { typeText } : {}),
    ...(defaultText !== undefined ? { defaultText } : {}),
  };
}

function paramInfo(node: SyntaxNode): Omit<ParamInfo, 'ordinal'> | undefined {
  switch (node.type) {
    case 'identifier':
      return buildParam(node.text, node);
    case 'typed_parameter':
      return buildParam(
        paramName(node.namedChildren[0]),
        node,
        node.childForFieldName('type')?.text,
      );
    case 'default_parameter':
      return buildParam(
        paramName(node.childForFieldName('name')),
        node,
        undefined,
        node.childForFieldName('value')?.text,
      );
    case 'typed_default_parameter':
      return buildParam(
        paramName(node.childForFieldName('name')),
        node,
        node.childForFieldName('type')?.text,
        node.childForFieldName('value')?.text,
      );
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
      return buildParam(paramName(node), node);
    default:
      return undefined;
  }
}

/**
 * A `function_definition` (`name`, `parameters`, `body`, optional `return_type` fields; undefined
 * without a name or a parameters field):
 * - params: each named child of `parameters` in order: `identifier` (its text); `typed_parameter`
 *   (the name of its first named child, an identifier or a splat, with typeText its `type`);
 *   `default_parameter` and `typed_default_parameter` (`name`, with typeText `type` and defaultText
 *   `value` when present); `list_splat_pattern` and `dictionary_splat_pattern` (the identifier inside,
 *   no stars). Anything else (`/`, `*`, a tuple pattern) is no param.
 * - signature (archive): `<name>(<p>, ...)` with `<p>` = `name` or `name: typeText`, then
 *   ` -> <return_type text>` when there is one: `greet(name: str, times) -> str`.
 * - kind: in a TYPE_DECL `constructor` for `__init__`, else `method`; in the MODULE `function`.
 * - exported: the name has no leading `_`. async: the node's text starts with `async` and whitespace.
 * - docstringHead (archive; a class's too): the body's first named child is an `expression_statement`
 *   whose first named child is a `string`; that text without its prefix letters and matching quotes
 *   (`"""`, `'''`, `"`, `'`), trimmed, then its first line trimmed. None when absent or blank.
 * - nameNode: the `name` field; body: the `body` field.
 */
function classifyFunction(node: SyntaxNode, container: ContainerKind): MethodInfo | undefined {
  const nameNode = node.childForFieldName('name');
  const paramsNode = node.childForFieldName('parameters');
  if (nameNode === null || paramsNode === null) return undefined;

  const name = nameNode.text;
  // PASSTHROUGH (sprint 40 RED): the ordinal is the param's index, as before; decision 114's
  // positions (a MISSING name holds one) are the implementation.
  const params = paramsNode.namedChildren
    .map((param) => paramInfo(param))
    .filter((param): param is Omit<ParamInfo, 'ordinal'> => param !== undefined)
    .map((param, ordinal): ParamInfo => ({ ...param, ordinal }));

  const returnType = node.childForFieldName('return_type')?.text;
  const paramList = params
    .map((param) =>
      param.typeText !== undefined ? `${param.name}: ${param.typeText}` : param.name,
    )
    .join(', ');
  const signature = `${name}(${paramList})${returnType !== undefined ? ` -> ${returnType}` : ''}`;

  const isAsync = /^async\s/.test(node.text);
  const kind =
    container === 'TYPE_DECL' ? (name === '__init__' ? 'constructor' : 'method') : 'function';
  const body = node.childForFieldName('body');
  const head = leadingDocstring(body);

  return {
    declares: 'METHOD',
    name,
    nameNode,
    kind,
    signature,
    exported: isExported(name),
    async: isAsync,
    ...(head !== undefined ? { docstringHead: head } : {}),
    params,
    ...(body !== null ? { body } : {}),
  };
}

/**
 * A `class_definition`: undefined without a `name`; else `{ declares: 'TYPE_DECL', name, kind:
 * 'class', exported (no leading `_`), structural: true, docstringHead?, body: the body field }`.
 */
function classifyClass(node: SyntaxNode): TypeDeclInfo | undefined {
  const nameNode = node.childForFieldName('name');
  if (nameNode === null) return undefined;

  const name = nameNode.text;
  const body = node.childForFieldName('body');
  const head = leadingDocstring(body);

  return {
    declares: 'TYPE_DECL',
    name,
    kind: 'class',
    exported: isExported(name),
    structural: true,
    ...(head !== undefined ? { docstringHead: head } : {}),
    body: body ?? undefined,
  };
}

/**
 * An `expression_statement` whose first named child is an `assignment` with an `identifier` `left`
 * (`X = 1`, `X: int = 1`, `X: int`, the first name of `a = b = 1`): a MEMBER named by it, typeText its
 * `type` field, value its `right` field, each when present. A tuple, attribute or augmented
 * assignment, or any other statement, is undefined.
 */
function classifyAssignment(node: SyntaxNode): MemberInfo | undefined {
  const inner = node.namedChildren[0];
  if (inner?.type !== 'assignment') return undefined;
  const left = inner.childForFieldName('left');
  if (left?.type !== 'identifier') return undefined;

  const typeText = inner.childForFieldName('type')?.text;
  const value = inner.childForFieldName('right') ?? undefined;

  return {
    declares: 'MEMBER',
    name: left.text,
    ...(typeText !== undefined ? { typeText } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

/**
 * The declaration table (sparse by design: anything else is undefined): `function_definition`,
 * `class_definition`, an assignment `expression_statement`, and a `decorated_definition`, which is
 * whatever its `definition` field (a function or a class) classifies as in the same container, so the
 * walker gives it the decorated range (decision 107).
 */
function classify(node: SyntaxNode, container: ContainerKind): DeclarationInfo | undefined {
  switch (node.type) {
    case 'function_definition':
      return classifyFunction(node, container);
    case 'class_definition':
      return classifyClass(node);
    case 'expression_statement':
      return classifyAssignment(node);
    case 'decorated_definition': {
      const definition = node.childForFieldName('definition');
      return definition === null ? undefined : classify(definition, container);
    }
    default:
      return undefined;
  }
}

/**
 * The builtin table: archive f18ee71 builtins/python-stdlib.ts and 21754b4 pythonPath.ts
 * PYTHON_BUILTINS reconciled as a union (11-salvage row 60). Compiled in, never configuration.
 */
const PYTHON_BUILTINS: ReadonlySet<string> = new Set(
  [
    'abs all any bool bytes callable chr classmethod dict dir divmod enumerate filter float format',
    'frozenset getattr hasattr hash hex id input int isinstance issubclass iter len list map max min',
    'next object oct open ord pow print property range repr reversed round set setattr slice sorted',
    'staticmethod str sum super tuple type vars zip',
  ]
    .join(' ')
    .split(' '),
);

const TRANSPARENT = new Set(['lambda']);
const STOP = new Set(['function_definition', 'class_definition', 'decorated_definition']);

/** An identifier, or a chain of identifier attributes: its names outermost first and its last token. */
function nameChain(node: SyntaxNode): { parts: readonly string[]; last: SyntaxNode } | undefined {
  if (node.type === 'identifier') return { parts: [node.text], last: node };
  if (node.type !== 'attribute') return undefined;
  const object = node.childForFieldName('object');
  const attribute = node.childForFieldName('attribute');
  if (object === null || attribute?.type !== 'identifier') return undefined;
  const inner = nameChain(object);
  return inner === undefined
    ? undefined
    : { parts: [...inner.parts, attribute.text], last: attribute };
}

/** A `keyword_argument` is checked by its `value`; anything else as it is. */
function argInfo(node: SyntaxNode): ArgInfo {
  const value = node.type === 'keyword_argument' ? node.childForFieldName('value') : node;
  return value?.type === 'identifier' ? { node, identifier: value.text } : { node };
}

/** A callee read as a CallInfo, or undefined when it is not a name (a call, subscript or parens). */
function callInfo(
  callee: SyntaxNode,
  kind: CallKind,
  argList: SyntaxNode | null,
): CallInfo | undefined {
  const args = (argList?.namedChildren ?? []).map(argInfo);
  if (callee.type === 'identifier') {
    const name = callee.text;
    const builtin: BuiltinTarget | undefined = PYTHON_BUILTINS.has(name)
      ? { scheme: 'site', package: 'python-stdlib', descriptors: [{ kind: 'method', name }] }
      : undefined;
    return {
      emits: 'CALL',
      kind,
      calleeName: name,
      nameParts: [name],
      nameNode: callee,
      args,
      ...(builtin !== undefined ? { builtin } : {}),
    };
  }
  if (callee.type !== 'attribute') return undefined;
  const object = callee.childForFieldName('object');
  const attribute = callee.childForFieldName('attribute');
  if (object === null || attribute?.type !== 'identifier') return undefined;
  // The conservative receiver rule (subgraph.ts, kept by 11-salvage.yaml): a receiver token only for
  // a name chain, never for `f(x).g()` or `a[0].g()`, whose nameParts are the last segment alone.
  const receiver = nameChain(object);
  return {
    emits: 'CALL',
    kind,
    calleeName: attribute.text,
    receiverText: object.text,
    nameParts: [...(receiver?.parts ?? []), attribute.text],
    nameNode: attribute,
    ...(receiver !== undefined ? { receiverNode: receiver.last } : {}),
    args,
  };
}

/**
 * The expression table (archive python.ts classifyExpressionPy, calleeShape, argInfos; subgraph.ts's
 * receiver rule), sparse by design:
 * - `call` with a `function` field that is an `identifier` (bare) or an `attribute` whose `attribute`
 *   is an identifier: a CallInfo of kind `call`. Any other callee (a call, subscript, parenthesized
 *   expression) is undefined, so the walker descends it ordinarily.
 *   - calleeName: the identifier's text, or the attribute's `attribute` text; nameNode: that token.
 *   - receiverText: the attribute's `object` text as written (`a.b`, `f(x)`, `a[0]`); absent when bare.
 *   - nameParts: the callee chain outermost first when every link is an identifier or an attribute of
 *     identifiers (`['g', 'greet']`, `['a', 'b', 'c']`); for a computed receiver the last segment alone.
 *   - receiverNode: only when the `object` is an identifier or a chain of identifier attributes: the
 *     chain's LAST identifier (`b` of `a.b.c()`, subgraph.ts receiverToken); absent for `f(x).g()`,
 *     `a[0].g()` (the conservative receiver rule, 11-salvage.yaml).
 *   - args: each named child of the `arguments` field in order; `identifier` is set for a bare
 *     identifier, and for a `keyword_argument` whose `value` is a bare identifier (that value's text).
 *   - builtin: for a bare callee whose name is in the builtin table, `{ scheme: 'site', package:
 *     'python-stdlib', descriptors: [{ kind: 'method', name }] }` (archive builtins/python-stdlib.ts);
 *     never for an attribute callee.
 * - `decorator`: a CallInfo of kind `decorator` for its expression (the decorator node's one named
 *   child): an identifier or an identifier attribute is read as a callee as above, with args `[]` (no
 *   argument list is written); a `call` expression (`@app.route("/")`) is read as that call (its
 *   callee and args), and the walker then descends only its arguments. Anything else is undefined.
 * - `lambda`: `{ emits: 'none', descend: 'transparent' }` (an inline callback: its calls count in the
 *   enclosing region).
 * - `function_definition`, `class_definition`, `decorated_definition`: `{ emits: 'none', descend:
 *   'stop' }` (a nested named declaration is never descended, decision 92).
 * - anything else: undefined (descend ordinarily).
 */
function classifyExpression(node: SyntaxNode): ExpressionVerdict | undefined {
  if (TRANSPARENT.has(node.type)) return { emits: 'none', descend: 'transparent' };
  if (STOP.has(node.type)) return { emits: 'none', descend: 'stop' };
  const expression = node.type === 'decorator' ? node.namedChildren[0] : node;
  const kind: CallKind = node.type === 'decorator' ? 'decorator' : 'call';
  if (expression?.type === 'call') {
    const callee = expression.childForFieldName('function');
    return callee === null
      ? undefined
      : callInfo(callee, kind, expression.childForFieldName('arguments'));
  }
  return node.type === 'decorator' && expression !== undefined
    ? callInfo(expression, kind, null)
    : undefined;
}

/**
 * Every name a region binds by a plain assignment whose `left` is an `identifier` (`x = 1`,
 * `x: int = 1`), in source order, anywhere in the region's tree except inside a `lambda`, a
 * `function_definition` or a `class_definition` (their own scopes); an assignment's right side is not
 * searched (archive localBindingsPy). A tuple, attribute or augmented assignment binds nothing here (a
 * documented gap, as are `for`, `with`, `except` and walrus binders). REACHING_DEF treats each as
 * shadowing an outer binding.
 */
function localBindings(regionRoot: SyntaxNode): readonly string[] {
  const names: string[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      if (left?.type === 'identifier') names.push(left.text);
      return;
    }
    if (TRANSPARENT.has(node.type) || STOP.has(node.type)) return;
    for (const child of node.namedChildren) visit(child);
  };
  visit(regionRoot);
  return names;
}

/**
 * Total over the 14 labels and 15 edge types (I13), honest against the ladder both ways (I14). The
 * same frozen object on every call (the nodes and edges records frozen too): compiled in, never
 * configuration.
 */
function coverage(): CoverageManifest {
  return PYTHON_COVERAGE;
}

export const pythonAdapter: LanguageAdapter = {
  grammarId: 'python',
  language: 'python',
  moduleRootType: 'module',
  moduleName,
  classify,
  classifyExpression,
  localBindings,
  coverage,
};
