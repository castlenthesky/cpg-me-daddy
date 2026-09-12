/**
 * The parser seam (F4).
 *
 * `web-tree-sitter` (wasm) is the v1 binding for both the daemon and the VSIX —
 * native was rejected on a measured segfault at `require('tree-sitter')` under
 * Node 20, a nine-platform VSIX matrix and no meaningful speed win
 * (60-delivery.yaml F4 rationale_wasm_over_native). This interface is what
 * keeps that a decision rather than a commitment: a native backend for the
 * headless daemon can be added later without the rest of the engine noticing.
 *
 * It is deliberately tiny. F4 is about *loading* grammars and ABI safety.
 * Queries, tree caching and extraction land in later units and will extend this
 * interface then, not now.
 */
import type { AbiRange } from "./abi";
import type { GrammarId } from "./grammars";

/** A grammar that loaded and passed the ABI gate. */
export interface LoadedGrammar {
  readonly id: GrammarId;
  /** The grammar's own ABI version, verified inside the runtime's range. */
  readonly abiVersion: number;
}

/**
 * The result of one parse.
 *
 * `rootType` and `hasError` are lifted out of the backend-specific tree so the
 * F4 gate — and anything else that only needs "did this parse cleanly" — never
 * has to touch the binding's node API.
 */
export interface ParsedSource<TTree> {
  readonly grammarId: GrammarId;
  /**
   * The backend's syntax tree. For wasm backends this holds memory outside the
   * JS heap: the caller owns it and must release it (M1.3 gates wasm memory).
   */
  readonly tree: TTree;
  /** Type of the root node, e.g. `program` for TS/JS, `module` for Python. */
  readonly rootType: string;
  /** True if the tree contains any ERROR or MISSING node. */
  readonly hasError: boolean;
}

/** A source of parse trees. One implementation today: {@link WebTreeSitterBackend}. */
export interface ParserBackend<TTree = unknown> {
  /** Stable identifier for logs and diagnostics, e.g. `"web-tree-sitter"`. */
  readonly id: string;

  /** Initialise the runtime. Idempotent; safe to call concurrently. */
  init(): Promise<void>;

  /**
   * The ABI range this backend accepts. Throws if called before {@link init}
   * has resolved — reading it early is the exact trap `requireAbiRange` guards.
   */
  abiSupport(): AbiRange;

  /**
   * Load a grammar, asserting its ABI. Cached: repeated calls are cheap.
   * @throws AbiError if the grammar's ABI is outside {@link abiSupport}.
   */
  loadGrammar(id: GrammarId): Promise<LoadedGrammar>;

  /** Parse `source` with `id`'s grammar, loading it on first use. */
  parse(id: GrammarId, source: string): Promise<ParsedSource<TTree>>;

  /** Release every parser and cached grammar this backend holds. */
  dispose(): void;
}
