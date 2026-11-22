// REAL: grammar loading with provenance and the ABI gate, parse, handle lifetime, dispose.
// SEAT: retain/releaseDocument (the retained-tree cache, I25/I26). No caller exists yet, so both throw.
import {
  Language,
  LANGUAGE_VERSION,
  MIN_COMPATIBLE_VERSION,
  Parser,
  type Node,
  type Tree,
} from 'web-tree-sitter';
import type {
  DocumentKey,
  GrammarProvenance,
  GrammarSource,
  LanguageId,
  LanguageRegistration,
  LanguageRegistry,
  ParseDiagnostics,
  ParseError,
  ParseHandle,
  ParseOutcome,
  ParseService,
  SyntaxNode,
} from './contract';

/** Reading `root` from a released handle is a caller bug (I24), one of the two throws C-PARSE allows. */
export class HandleReleasedError extends Error {
  constructor(key: string) {
    super(`ParseHandle for ${key} was released; its tree is gone`);
    this.name = 'HandleReleasedError';
  }
}

export interface ParseServiceOptions {
  /** Frozen by the composition root before it is handed here. */
  readonly registry: LanguageRegistry;
  readonly source: GrammarSource;
}

interface LoadedGrammar {
  readonly parser: Parser;
  readonly registration: LanguageRegistration;
  readonly provenance: GrammarProvenance;
}

const fail = (error: ParseError): { ok: false; error: ParseError } => ({ ok: false, error });

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function diagnose(root: Node): ParseDiagnostics {
  let errorNodeCount = 0;
  let missingNodeCount = 0;
  let errorChars = 0;
  // An explicit stack: a deeply nested file must not overflow the JS call stack.
  const stack: Node[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.isMissing) missingNodeCount++;
    if (node.isError) {
      errorNodeCount++;
      errorChars += node.endIndex - node.startIndex;
    } else stack.push(...node.children);
  }
  const total = root.endIndex - root.startIndex;
  return { errorNodeCount, missingNodeCount, errorSpanRatio: total === 0 ? 0 : errorChars / total };
}

export function createParseService({ registry, source }: ParseServiceOptions): ParseService {
  let runtime: Promise<ParseError | undefined> | undefined;
  const grammars = new Map<LanguageId, Promise<LoadedGrammar | ParseError>>();
  const loaded: LoadedGrammar[] = [];
  const live = new Set<ParseHandle>();
  let grammarLoads = 0;
  let disposed = false;

  // A failed init or load is forgotten so a fixed cause succeeds next time (I15); a success is
  // shared by promise, so concurrent first use loads once (I16).
  async function startRuntime(): Promise<ParseError | undefined> {
    try {
      await Parser.init();
      return undefined;
    } catch (cause) {
      runtime = undefined;
      return { code: 'runtime-unavailable', message: `Parser.init failed: ${String(cause)}` };
    }
  }
  function initRuntime(): Promise<ParseError | undefined> {
    runtime ??= startRuntime();
    return runtime;
  }

  async function loadGrammar(
    registration: LanguageRegistration,
  ): Promise<LoadedGrammar | ParseError> {
    const language = registration.id;
    const initError = await initRuntime();
    if (initError) return initError;
    // Live bindings, undefined until Parser.init resolves (I13): read them only here.
    const abi = { minCompatible: MIN_COMPATIBLE_VERSION, languageVersion: LANGUAGE_VERSION };
    if (!Number.isInteger(abi.minCompatible) || !Number.isInteger(abi.languageVersion))
      return { code: 'abi-unreadable', language, message: 'web-tree-sitter exposed no ABI range' };
    grammarLoads++;
    const bytes = await source.load(registration.grammar);
    if (!bytes.ok)
      return {
        code: 'grammar-unavailable',
        language,
        message: `${source.describe()}: ${bytes.message}`,
      };
    let grammar: Language;
    try {
      grammar = await Language.load(bytes.bytes);
    } catch (cause) {
      return { code: 'grammar-rejected', language, message: `${bytes.origin}: ${String(cause)}` };
    }
    if (grammar.abiVersion < abi.minCompatible || grammar.abiVersion > abi.languageVersion)
      return {
        code: 'abi-out-of-range',
        language,
        message: `${bytes.origin} has ABI ${String(grammar.abiVersion)}, runtime accepts ${String(abi.minCompatible)}..${String(abi.languageVersion)}`,
      };
    if (disposed) return { code: 'disposed', language, message: 'disposed while loading' };
    const parser = new Parser();
    parser.setLanguage(grammar);
    const provenance: GrammarProvenance = {
      language,
      packageName: registration.grammar.packageName,
      wasmFile: registration.grammar.wasmFile,
      origin: bytes.origin,
      bytesSha256: await sha256(bytes.bytes),
      abiVersion: grammar.abiVersion,
      abiSupported: abi,
    };
    const result = { parser, registration, provenance };
    loaded.push(result);
    return result;
  }

  function grammarFor(registration: LanguageRegistration): Promise<LoadedGrammar | ParseError> {
    let pending = grammars.get(registration.id);
    if (pending === undefined) {
      pending = loadGrammar(registration).then((result) => {
        if ('code' in result) grammars.delete(registration.id);
        return result;
      });
      grammars.set(registration.id, pending);
    }
    return pending;
  }

  function makeHandle(key: DocumentKey, grammar: LoadedGrammar, tree: Tree): ParseHandle {
    let released = false;
    const handle: ParseHandle = {
      key,
      language: grammar.registration.id,
      get root(): SyntaxNode {
        if (released) throw new HandleReleasedError(key);
        return tree.rootNode;
      },
      rootType: tree.rootNode.type,
      hasError: tree.rootNode.hasError,
      rootTypeMismatch: tree.rootNode.type !== grammar.registration.rootNodeType,
      get released() {
        return released;
      },
      diagnostics() {
        if (released) throw new HandleReleasedError(key);
        return diagnose(tree.rootNode);
      },
      release() {
        if (released) return;
        released = true;
        live.delete(handle);
        tree.delete();
      },
    };
    live.add(handle);
    return handle;
  }

  return {
    async ensureReady(ids) {
      if (disposed) return [{ code: 'disposed', message: 'the parse service was disposed' }];
      const errors: ParseError[] = [];
      for (const id of ids) {
        const registration = registry.get(id);
        const result = registration
          ? await grammarFor(registration)
          : { code: 'unsupported-language' as const, language: id, message: `no language ${id}` };
        if ('code' in result) errors.push(result);
      }
      return errors;
    },

    async parse({ key, text, language }): Promise<ParseOutcome> {
      if (disposed)
        return fail({ code: 'disposed', key, message: 'the parse service was disposed' });
      const id = language ?? registry.languageForPath(key);
      const registration = id === undefined ? undefined : registry.get(id);
      if (registration === undefined)
        return fail({
          code: 'unsupported-language',
          key,
          ...(id === undefined ? {} : { language: id }),
          message: `no registered language for ${key}`,
        });
      const grammar = await grammarFor(registration);
      if ('code' in grammar) return fail({ ...grammar, key });
      const tree = grammar.parser.parse(text);
      if (tree === null)
        return fail({
          code: 'no-tree',
          key,
          language: registration.id,
          message: 'parser returned no tree',
        });
      return { ok: true, handle: makeHandle(key, grammar, tree) };
    },

    retain() {
      throw new Error(
        'SEAT: the retained-tree cache (C-PARSE I25/I26) lands with its first caller',
      );
    },
    releaseDocument() {
      throw new Error(
        'SEAT: the retained-tree cache (C-PARSE I25/I26) lands with its first caller',
      );
    },

    provenance: () => loaded.map((g) => g.provenance),

    stats() {
      return { liveHandles: live.size, cachedTrees: 0, grammarLoads, debugDumpsWritten: 0 };
    },

    dispose() {
      const leakedHandles = live.size;
      for (const handle of live) handle.release();
      for (const g of loaded) g.parser.delete();
      loaded.length = 0;
      grammars.clear();
      disposed = true;
      return { leakedHandles, cachedTreesReleased: 0 };
    },
  };
}
