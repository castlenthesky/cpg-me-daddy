/**
 * The grammar registry (F4).
 *
 * Four grammars, and the file extensions that route to each. The
 * typescript/tsx split is load-bearing, not cosmetic: the TypeScript grammar
 * rejects JSX, and the TSX grammar rejects the `<T>x` cast form, because the
 * two syntaxes are genuinely ambiguous. Routing `.tsx` at the TypeScript
 * grammar produces an ERROR tree, not a warning — so the mapping IS the
 * correctness boundary. (40-research.yaml adopted_defaults.parsing.grammars.)
 */

/** The language ids the engine parses. */
export const GRAMMAR_IDS = ["typescript", "tsx", "javascript", "python"] as const;

/** One of the four language ids. */
export type GrammarId = (typeof GRAMMAR_IDS)[number];

/** Static facts about one grammar. */
export interface GrammarSpec {
  /** Language id. */
  readonly id: GrammarId;
  /** Basename of the `.wasm` inside the grammar directory. */
  readonly wasmFile: string;
  /** Root node type a clean parse produces. Asserted by the F4 load gate. */
  readonly rootNodeType: string;
  /** Lower-case file extensions, leading dot included, that route here. */
  readonly extensions: readonly string[];
}

/** The registry. Keyed by language id. */
export const GRAMMARS: Readonly<Record<GrammarId, GrammarSpec>> = {
  typescript: {
    id: "typescript",
    wasmFile: "tree-sitter-typescript.wasm",
    rootNodeType: "program",
    extensions: [".ts", ".mts", ".cts"],
  },
  javascript: {
    id: "javascript",
    wasmFile: "tree-sitter-javascript.wasm",
    rootNodeType: "program",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
  },
  tsx: {
    id: "tsx",
    wasmFile: "tree-sitter-tsx.wasm",
    rootNodeType: "program",
    extensions: [".tsx"],
  },
  python: {
    id: "python",
    wasmFile: "tree-sitter-python.wasm",
    rootNodeType: "module",
    extensions: [".py"],
  },
};

/** Extension (lower case, leading dot) to language id. Derived from GRAMMARS. */
export const EXTENSION_TO_GRAMMAR: ReadonlyMap<string, GrammarId> = new Map(
  GRAMMAR_IDS.flatMap((id) => GRAMMARS[id].extensions.map((ext) => [ext, id] as const)),
);

/** Type guard for an arbitrary string being one of the four language ids. */
export function isGrammarId(value: string): value is GrammarId {
  return Object.prototype.hasOwnProperty.call(GRAMMARS, value);
}

/**
 * Language id for a file extension, or `undefined` if we do not parse it.
 * Accepts `"ts"` and `".TS"` alike.
 */
export function grammarForExtension(extension: string): GrammarId | undefined {
  const normalized = extension.toLowerCase();
  return EXTENSION_TO_GRAMMAR.get(normalized.startsWith(".") ? normalized : `.${normalized}`);
}

/**
 * Language id for a file path, or `undefined` if we do not parse it.
 *
 * Deliberately extension-only: no shebang sniffing, no content inspection. The
 * watcher hands us paths by the thousand and this runs on every one of them.
 */
export function grammarForPath(filePath: string): GrammarId | undefined {
  const basename = filePath.slice(
    Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1,
  );
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return grammarForExtension(basename.slice(dot));
}
