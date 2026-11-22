// REAL. The language registry (C-PARSE I5, I6): extension routing with no aliasing and no default.
import type {
  LanguageId,
  LanguageRegistration,
  LanguageRegistry,
  RegisterOutcome,
} from './contract';

const GRAMMAR_PACKAGE = '@vscode/tree-sitter-wasm';

/**
 * The four grammars v1 parses. typescript and tsx are separate on purpose: the typescript grammar has
 * no JSX and the tsx grammar rejects `<T>x` casts, so routing `.tsx` to typescript yields an ERROR
 * tree (ladder rung 12). javascript is parseable but has no extract adapter in v1 (C-PARSE Q2).
 */
export const BUILTIN_LANGUAGES: readonly LanguageRegistration[] = [
  {
    id: 'python',
    grammar: { packageName: GRAMMAR_PACKAGE, wasmFile: 'tree-sitter-python.wasm' },
    rootNodeType: 'module',
    extensions: ['.py'],
  },
  {
    id: 'typescript',
    grammar: { packageName: GRAMMAR_PACKAGE, wasmFile: 'tree-sitter-typescript.wasm' },
    rootNodeType: 'program',
    extensions: ['.ts', '.mts', '.cts'],
  },
  {
    id: 'tsx',
    grammar: { packageName: GRAMMAR_PACKAGE, wasmFile: 'tree-sitter-tsx.wasm' },
    rootNodeType: 'program',
    extensions: ['.tsx'],
  },
  {
    id: 'javascript',
    grammar: { packageName: GRAMMAR_PACKAGE, wasmFile: 'tree-sitter-javascript.wasm' },
    rootNodeType: 'program',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  },
];

function normalizeExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

/** An empty, unfrozen registry. The composition root registers what it needs, then freezes it. */
export function createLanguageRegistry(): LanguageRegistry {
  const byId = new Map<LanguageId, LanguageRegistration>();
  const byExtension = new Map<string, LanguageId>();
  let frozen = false;

  const languageForExtension = (extension: string): LanguageId | undefined =>
    byExtension.get(normalizeExtension(extension));

  return {
    register(registration): RegisterOutcome {
      if (frozen) return { ok: false, reason: 'frozen' };
      if (byId.has(registration.id))
        return { ok: false, reason: 'duplicate-id', id: registration.id };
      const extensions = registration.extensions.map(normalizeExtension);
      for (const extension of extensions) {
        const by = byExtension.get(extension);
        if (by !== undefined) return { ok: false, reason: 'extension-claimed', extension, by };
      }
      byId.set(registration.id, { ...registration, extensions });
      for (const extension of extensions) byExtension.set(extension, registration.id);
      return { ok: true };
    },
    freeze() {
      frozen = true;
    },
    get frozen() {
      return frozen;
    },
    get: (id) => byId.get(id),
    languageForExtension,
    languageForPath(path) {
      const base = path.slice(path.lastIndexOf('/') + 1);
      const dot = base.lastIndexOf('.');
      return dot <= 0 ? undefined : languageForExtension(base.slice(dot));
    },
    ids: () => [...byId.keys()],
  };
}
