/**
 * The wasm parser backend (F4 / spike SP1).
 *
 * Pinned to `web-tree-sitter` 0.27.0 with the prebuilt grammars from
 * `@vscode/tree-sitter-wasm` 0.3.1 — the day-one fallback named in the F4 gate,
 * taken deliberately: it ships exactly the four grammars we need and removes
 * emscripten and `tree-sitter-cli` from CI entirely. The {@link ParserBackend}
 * seam is what keeps a self-built grammar set (or a native backend) a later
 * option rather than a rewrite.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  Language,
  LANGUAGE_VERSION,
  MIN_COMPATIBLE_VERSION,
  Parser,
  type Tree,
} from "web-tree-sitter";

import { type AbiRange, assertAbiCompatible, requireAbiRange } from "./abi";
import type { LoadedGrammar, ParsedSource, ParserBackend } from "./backend";
import { GRAMMARS, type GrammarId, isGrammarId } from "./grammars";
import { resolveGrammarDir } from "./wasm-locator";

/** Construction options for {@link WebTreeSitterBackend}. */
export interface WebTreeSitterBackendOptions {
  /**
   * Directory holding the grammar `.wasm` files. Defaults to the resolution
   * chain in `wasm-locator.ts`; set it when bundling.
   */
  readonly grammarDir?: string;
}

export class WebTreeSitterBackend implements ParserBackend<Tree> {
  public readonly id = "web-tree-sitter";

  private readonly grammarDir: string;
  private readonly languages = new Map<GrammarId, Language>();
  private readonly parsers = new Map<GrammarId, Parser>();
  private initialization: Promise<void> | undefined;
  private initialized = false;

  constructor(options: WebTreeSitterBackendOptions = {}) {
    this.grammarDir = resolveGrammarDir(options.grammarDir);
  }

  /** The directory this backend reads grammars from. Useful in diagnostics. */
  public get grammarDirectory(): string {
    return this.grammarDir;
  }

  public async init(): Promise<void> {
    if (this.initialization === undefined) {
      this.initialization = this.runInit().catch((error: unknown) => {
        // Do not cache a failed init: a missing wasm or a bad install should be
        // retryable once the cause is fixed, not poisoned for the process life.
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  private async runInit(): Promise<void> {
    await Parser.init();
    // Read the ABI constants only HERE, after init resolved. They are
    // module-level `export let` bindings in web-tree-sitter and are `undefined`
    // until this point; requireAbiRange turns that into a loud failure so the
    // per-grammar assertion can never pass vacuously. See abi.ts.
    requireAbiRange(MIN_COMPATIBLE_VERSION, LANGUAGE_VERSION);
    this.initialized = true;
  }

  public abiSupport(): AbiRange {
    if (!this.initialized) {
      throw new Error(
        "WebTreeSitterBackend.abiSupport() called before init() resolved. The ABI constants are " +
          "undefined until then; await init() first.",
      );
    }
    return requireAbiRange(MIN_COMPATIBLE_VERSION, LANGUAGE_VERSION);
  }

  public async loadGrammar(id: GrammarId): Promise<LoadedGrammar> {
    const cached = this.languages.get(id);
    if (cached !== undefined) {
      return { id, abiVersion: cached.abiVersion };
    }
    if (!isGrammarId(id)) {
      throw new Error(
        `Unknown grammar '${String(id)}'. Known grammars: ${Object.keys(GRAMMARS).join(", ")}.`,
      );
    }

    await this.init();

    const wasmPath = join(this.grammarDir, GRAMMARS[id].wasmFile);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(wasmPath));
    } catch (cause) {
      throw new Error(
        `Grammar '${id}': cannot read its wasm at ${wasmPath}. Check the install of ` +
          "@vscode/tree-sitter-wasm, or point CPG_GRAMMAR_DIR at a directory holding the " +
          "grammar .wasm files.",
        { cause },
      );
    }

    let language: Language;
    try {
      language = await Language.load(bytes);
    } catch (cause) {
      throw new Error(
        `Grammar '${id}': web-tree-sitter refused the wasm at ${wasmPath}. The file is present ` +
          "but is not a loadable tree-sitter grammar for this runtime.",
        { cause },
      );
    }

    // The gate. Throws AbiError naming the grammar, its ABI and the range.
    assertAbiCompatible(id, language.abiVersion, MIN_COMPATIBLE_VERSION, LANGUAGE_VERSION);

    this.languages.set(id, language);
    return { id, abiVersion: language.abiVersion };
  }

  public async parse(id: GrammarId, source: string): Promise<ParsedSource<Tree>> {
    const parser = await this.parserFor(id);
    const tree = parser.parse(source);
    if (tree === null) {
      throw new Error(
        `Grammar '${id}': web-tree-sitter returned no tree for a ${source.length}-character ` +
          "source. This is a runtime failure, not a syntax error — a syntax error still yields " +
          "a tree with ERROR nodes.",
      );
    }
    return {
      grammarId: id,
      tree,
      rootType: tree.rootNode.type,
      hasError: tree.rootNode.hasError,
    };
  }

  private async parserFor(id: GrammarId): Promise<Parser> {
    const existing = this.parsers.get(id);
    if (existing !== undefined) {
      return existing;
    }
    await this.loadGrammar(id);
    const parser = new Parser();
    // Non-null: loadGrammar populated the map or threw.
    parser.setLanguage(this.languages.get(id) ?? null);
    this.parsers.set(id, parser);
    return parser;
  }

  public dispose(): void {
    for (const parser of this.parsers.values()) {
      parser.delete();
    }
    this.parsers.clear();
    // Language has no delete() in web-tree-sitter 0.27; dropping the reference
    // is all the API offers.
    this.languages.clear();
  }
}
