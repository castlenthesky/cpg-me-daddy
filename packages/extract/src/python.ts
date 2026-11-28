// The Python adapter: the MODULE tier (U6a.2-2) and the declaration half (U6a.2-3), ported from archive
// f18ee71:packages/engine/src/extract/python.ts (classifyFunction, classifyClass, classifyAssignment,
// paramInfo, the docstring helpers), plus `decorated_definition` (decision 107). The expression half
// (Pass B calls, U6a.2-4a) from classifyExpressionPy, calleeShape, argInfos and localBindingsPy, with
// resolveCallee's attribution REMOVED: a call is syntax, plus the builtin table's answer. The import
// table (Pass B imports, BMO-134) classifies import_statement, import_from_statement and
// future_import_statement through node types and fields (archive 21754b4 imports.ts).

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
  ImportBindingInfo,
  ImportInfo,
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
    IMPORT: emits('import_statement', 'import_from_statement', 'future_import_statement'),
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
      'import_statement',
      'import_from_statement',
      'future_import_statement',
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

/** A node's text as a property value, or `undefined` when absent or containing U+0000 (decision 115, I19). */
function propertyText(node: SyntaxNode | null): string | undefined {
  if (node === null || node.text.includes('\u0000')) return undefined;
  return node.text;
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
        propertyText(node.childForFieldName('type')),
      );
    case 'default_parameter':
      return buildParam(
        paramName(node.childForFieldName('name')),
        node,
        undefined,
        propertyText(node.childForFieldName('value')),
      );
    case 'typed_default_parameter':
      return buildParam(
        paramName(node.childForFieldName('name')),
        node,
        propertyText(node.childForFieldName('type')),
        propertyText(node.childForFieldName('value')),
      );
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
      return buildParam(paramName(node), node);
    default:
      return undefined;
  }
}

function splatPrefix(node: SyntaxNode): '' | '*' | '**' {
  const holder =
    node.type === 'typed_parameter'
      ? node.namedChildren[0]
      : node.type === 'default_parameter' || node.type === 'typed_default_parameter'
        ? node.childForFieldName('name')
        : node;
  if (holder?.type === 'list_splat_pattern') return '*';
  if (holder?.type === 'dictionary_splat_pattern') return '**';
  return '';
}

function paramSignature(node: SyntaxNode, name: string): string {
  const type = node.childForFieldName('type')?.text;
  const value = node.childForFieldName('value')?.text;
  let result = `${splatPrefix(node)}${name}`;
  if (type !== undefined) result += `: ${type}`;
  if (value !== undefined) result += type !== undefined ? ` = ${value}` : `=${value}`;
  return result;
}

/**
 * A `function_definition` (`name`, `parameters`, `body`, optional `return_type` fields; undefined
 * without a name or a parameters field):
 * - params: each named child of `parameters` in order: `identifier` (its text); `typed_parameter`
 *   (the name of its first named child, an identifier or a splat, with typeText its `type`);
 *   `default_parameter` and `typed_default_parameter` (`name`, with typeText `type` and defaultText
 *   `value` when present); `list_splat_pattern` and `dictionary_splat_pattern` (the identifier inside,
 *   no stars). Anything else (`/`, `*`, a tuple pattern, an ERROR) is no param and takes no position.
 *   Every other child takes the next 0-based position; a param whose name is `''` (a MISSING
 *   identifier is zero-width) yields no ParamInfo while still consuming its position, and each kept
 *   param gets its position as `ordinal` (decision 114). A `typeText` or `defaultText` whose text
 *   contains U+0000 is omitted (decision 115, C-EXTRACT I19).
 * - signature (stop-list 197): `<name>(<p>, ...)` walking `parameters`'s named children in order,
 *   then ` -> <return_type text>` when there is one, with every U+0000 character removed (decision
 *   115, C-EXTRACT I19): a `keyword_separator` writes `*`; a `positional_separator` writes `/`; a
 *   kept param writes `*` for a `list_splat_pattern` or `**` for a `dictionary_splat_pattern` (the
 *   param itself, a `typed_parameter`'s first named child, or a default parameter's `name` field),
 *   then the name, then `: <type field text>` when the param has a `type` field, then ` = <value text>`
 *   when it has both `type` and `value` fields or `=<value text>` when it has only `value` (read from
 *   the raw fields, even when `typeText` or `defaultText` was omitted); anything else writes nothing.
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
  const params: ParamInfo[] = [];
  const sigParts: string[] = [];
  let position = 0;
  for (const child of paramsNode.namedChildren) {
    if (child.type === 'keyword_separator') {
      sigParts.push('*');
      continue;
    }
    if (child.type === 'positional_separator') {
      sigParts.push('/');
      continue;
    }
    const info = paramInfo(child);
    if (info === undefined) continue;
    const ordinal = position;
    position += 1;
    if (info.name === '') continue;
    params.push({ ...info, ordinal });
    sigParts.push(paramSignature(child, info.name));
  }

  const returnType = node.childForFieldName('return_type')?.text;
  const signature =
    `${name}(${sigParts.join(', ')})${returnType !== undefined ? ` -> ${returnType}` : ''}`.replaceAll(
      '\u0000',
      '',
    );

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
 * 'class', exported (no leading `_`), structural: true, docstringHead?, body: the body field,
 * headerErrors? }`, where `headerErrors` holds the ERROR-typed nodes among the class's own named
 * children in source order and is present only when there is at least one (decision 117).
 */
function classifyClass(node: SyntaxNode): TypeDeclInfo | undefined {
  const nameNode = node.childForFieldName('name');
  if (nameNode === null) return undefined;

  const name = nameNode.text;
  const body = node.childForFieldName('body');
  const head = leadingDocstring(body);
  const headerErrors = node.namedChildren.filter((child) => child.type === 'ERROR');

  return {
    declares: 'TYPE_DECL',
    name,
    kind: 'class',
    exported: isExported(name),
    structural: true,
    ...(head !== undefined ? { docstringHead: head } : {}),
    body: body ?? undefined,
    ...(headerErrors.length > 0 ? { headerErrors } : {}),
  };
}

/**
 * An `expression_statement` whose first named child is an `assignment` with an `identifier` `left`
 * (`X = 1`, `X: int = 1`, `X: int`, the first name of `a = b = 1`): a MEMBER named by it, typeText its
 * `type` field (omitted when absent or containing U+0000; decision 115, C-EXTRACT I19), value its
 * `right` field when present. A `left` identifier whose text is `''` (a MISSING identifier is
 * zero-width) gives undefined (decision 118). A tuple, attribute or augmented assignment, or any
 * other statement, is undefined.
 */
function classifyAssignment(node: SyntaxNode): MemberInfo | undefined {
  const inner = node.namedChildren[0];
  if (inner?.type !== 'assignment') return undefined;
  const left = inner.childForFieldName('left');
  if (left?.type !== 'identifier' || left.text === '') return undefined;

  const typeText = propertyText(inner.childForFieldName('type'));
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

const IMPORT_STATEMENTS: ReadonlySet<string> = new Set([
  'import_statement',
  'import_from_statement',
  'future_import_statement',
]);

function dottedSegments(node: SyntaxNode): readonly string[] {
  return node.namedChildren
    .filter((child) => child.type === 'identifier' && child.text !== '')
    .map((child) => child.text);
}

function countDots(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === '.') count += 1;
  }
  return count;
}

function readNamedBinding(
  child: SyntaxNode,
): { nameNode: SyntaxNode; parts: readonly string[]; alias?: string } | undefined {
  if (child.type === 'dotted_name') {
    const parts = dottedSegments(child);
    return parts.length === 0 ? undefined : { nameNode: child, parts };
  }
  if (child.type === 'aliased_import') {
    const nameNode = child.childForFieldName('name');
    const aliasNode = child.childForFieldName('alias');
    if (nameNode?.type !== 'dotted_name' || aliasNode === null || aliasNode.text === '') {
      return undefined;
    }
    const parts = dottedSegments(nameNode);
    return parts.length === 0 ? undefined : { nameNode, parts, alias: aliasNode.text };
  }
  return undefined;
}

function classifyFromImport(
  node: SyntaxNode,
  module: string,
  relativeDepth: number,
  moduleNode: SyntaxNode | null,
): ImportInfo | undefined {
  const bindings: ImportBindingInfo[] = [];
  const importedNames: string[] = [];
  let lastAliased = false;

  for (const child of node.namedChildren) {
    if (
      moduleNode !== null &&
      child.type === moduleNode.type &&
      child.startIndex === moduleNode.startIndex
    ) {
      continue;
    }
    if (child.type === 'wildcard_import') {
      bindings.push({
        nameNode: child,
        nameParts: ['*'],
        binding: { module, relativeDepth, imported: '*', local: '*' },
        exported: isExported('*'),
      });
      importedNames.push('*');
      lastAliased = false;
      continue;
    }
    const entry = readNamedBinding(child);
    if (entry === undefined) continue;
    const imported = entry.parts.join('.');
    const local = entry.alias ?? imported;
    bindings.push({
      nameNode: entry.nameNode,
      nameParts: entry.parts,
      binding: { module, relativeDepth, imported, local },
      exported: isExported(local),
    });
    importedNames.push(imported);
    lastAliased = entry.alias !== undefined;
  }

  if (bindings.length === 0) return undefined;
  const alias = bindings.length === 1 && lastAliased ? bindings[0]?.binding.local : undefined;
  return {
    emits: 'IMPORT',
    sourceText: `${'.'.repeat(relativeDepth)}${module}`,
    importedNames,
    ...(alias !== undefined ? { alias } : {}),
    typeOnly: false,
    bindings,
  };
}

/**
 * The import table (archive 21754b4 imports.ts, read through node types instead of its keyword split),
 * for an `import_statement`, an `import_from_statement` or a `future_import_statement`; anything else
 * is undefined:
 * - A name's segments are the texts of its `dotted_name`'s `identifier` named children, so
 *   `a . b` reads `a.b`; the dotted form is the segments joined with `.`.
 * - `import_statement`: one binding per named child of type `dotted_name` or `aliased_import` (the
 *   module is the `aliased_import`'s `name` field), in source order; every other child (a comment, a
 *   line continuation, an ERROR) is none. Each binding: nameNode the module's `dotted_name`, nameParts
 *   its segments, binding `{ module: dotted, relativeDepth: 0, local }` with no `imported` (a
 *   whole-module import), local the `alias` field's text when aliased, else the first segment
 *   (`import os.path` binds `os`). sourceText is the bindings' modules joined with `,` (`os`,
 *   `os.path`, `a.b,d`); importedNames is `[]`.
 * - `import_from_statement`: the `module_name` field is a `dotted_name` (relativeDepth 0, module its
 *   dotted form) or a `relative_import` (relativeDepth the count of `.` in its `import_prefix` child's
 *   text, module the dotted form of its `dotted_name` child, `''` without one). sourceText is
 *   `.` repeated relativeDepth times, then module (`util`, `.`, `..pkg.sub`). One binding per named
 *   child of type `dotted_name` or `aliased_import` other than the `module_name` node (told apart by
 *   start index), in source order: nameNode the name's `dotted_name` (an `aliased_import`'s `name`
 *   field), nameParts its segments, binding `{ module, relativeDepth, imported: dotted, local: the
 *   alias field's text when aliased, else imported }`; a `wildcard_import` child is one binding in
 *   its place with nameNode the wildcard node, nameParts `['*']`, imported and local `*`.
 *   importedNames is each binding's `imported`, in order.
 * - `future_import_statement`: as an `import_from_statement` whose module is `__future__` at
 *   relativeDepth 0 (it has no `module_name` field), sourceText `__future__`.
 * - Every binding: `exported` is true unless local starts with `_` (archive isExported; decision 94).
 * - alias: present only when there is exactly one binding and it came from an `aliased_import`: that
 *   binding's local. typeOnly: always false (Python has no type-only import).
 * - A MISSING identifier (zero-width, text `''`) is no segment. A name left with no segment, or an
 *   `aliased_import` whose alias is `''`, is no binding, and a statement left with no binding is
 *   undefined, so `from m import ()` (recovered as one MISSING name) is no IMPORT: the MISSING-name
 *   analogue of decisions 114 and 118 (sprint 42 reading S42-7).
 */
function classifyImport(node: SyntaxNode): ImportInfo | undefined {
  if (node.type === 'import_statement') {
    const bindings: ImportBindingInfo[] = [];
    let lastAliased = false;
    for (const child of node.namedChildren) {
      const entry = readNamedBinding(child);
      const first = entry?.parts[0];
      if (entry === undefined || first === undefined) continue;
      const dotted = entry.parts.join('.');
      const local = entry.alias ?? first;
      bindings.push({
        nameNode: entry.nameNode,
        nameParts: entry.parts,
        binding: { module: dotted, relativeDepth: 0, local },
        exported: isExported(local),
      });
      lastAliased = entry.alias !== undefined;
    }
    if (bindings.length === 0) return undefined;
    const alias = bindings.length === 1 && lastAliased ? bindings[0]?.binding.local : undefined;
    return {
      emits: 'IMPORT',
      sourceText: bindings.map((b) => b.binding.module).join(','),
      importedNames: [],
      ...(alias !== undefined ? { alias } : {}),
      typeOnly: false,
      bindings,
    };
  }

  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    let relativeDepth = 0;
    let module = '';
    if (moduleNode?.type === 'dotted_name') {
      module = dottedSegments(moduleNode).join('.');
    } else if (moduleNode?.type === 'relative_import') {
      const prefix = moduleNode.namedChildren.find((child) => child.type === 'import_prefix');
      if (prefix !== undefined) relativeDepth = countDots(prefix.text);
      const dottedChild = moduleNode.namedChildren.find((child) => child.type === 'dotted_name');
      if (dottedChild !== undefined) module = dottedSegments(dottedChild).join('.');
    }
    return classifyFromImport(node, module, relativeDepth, moduleNode);
  }

  if (node.type === 'future_import_statement') {
    return classifyFromImport(node, '__future__', 0, null);
  }

  return undefined;
}

/**
 * The expression table (archive python.ts classifyExpressionPy, calleeShape, argInfos; subgraph.ts's
 * receiver rule), sparse by design:
 * - `import_statement`, `import_from_statement`, `future_import_statement`: the import table's ImportInfo
 *   (classifyImport, BMO-134), never descended.
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
  if (IMPORT_STATEMENTS.has(node.type)) return classifyImport(node);
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

const COMPOUND_STATEMENTS: ReadonlySet<string> = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'try_statement',
  'with_statement',
  'match_statement',
]);
const COMPOUND_CLAUSES: ReadonlySet<string> = new Set([
  'elif_clause',
  'else_clause',
  'except_clause',
  'finally_clause',
  'case_clause',
]);

function expandCompound(node: SyntaxNode): readonly SyntaxNode[] {
  return node.namedChildren.flatMap((child) => {
    if (child.type === 'block' && node.type !== 'match_statement') return child.namedChildren;
    if (child.type === 'block' || COMPOUND_CLAUSES.has(child.type)) return expandCompound(child);
    return [child];
  });
}

/**
 * A compound statement (stop-list 196): `if_statement`, `for_statement`, `while_statement`,
 * `try_statement`, `with_statement` and `match_statement` (`async for` and `async with` are the same
 * types). Its named children in source order, where a `block` is replaced by its named children, and a
 * clause (`elif_clause`, `else_clause`, `except_clause`, `finally_clause`, `case_clause`) or a
 * `match_statement`'s own `block` (which holds its case clauses) by what this rule gives for it, in
 * place. So a condition, a `with_clause`, a `for` target and iterable, an `except` value, a match
 * subject, a case pattern and guard, a comment and an ERROR stay as they are. Anything else is
 * undefined.
 */
function compoundChildren(node: SyntaxNode): readonly SyntaxNode[] | undefined {
  return COMPOUND_STATEMENTS.has(node.type) ? expandCompound(node) : undefined;
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
  compoundChildren,
  coverage,
};
