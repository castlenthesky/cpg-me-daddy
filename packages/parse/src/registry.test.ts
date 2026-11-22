import { describe, expect, it } from 'vitest';
import type { LanguageRegistration } from './contract';
import { BUILTIN_LANGUAGES, createLanguageRegistry } from './registry';

function builtins() {
  const registry = createLanguageRegistry();
  for (const r of BUILTIN_LANGUAGES) expect(registry.register(r)).toEqual({ ok: true });
  registry.freeze();
  return registry;
}

const fake = (id: string, extensions: string[]): LanguageRegistration => ({
  id,
  grammar: { packageName: 'p', wasmFile: `${id}.wasm` },
  rootNodeType: 'root',
  extensions,
});

describe('routing (C-PARSE I5)', () => {
  it.each([
    ['view.tsx', 'tsx'],
    ['a.ts', 'typescript'],
    ['a.mts', 'typescript'],
    ['a.cts', 'typescript'],
    ['a.js', 'javascript'],
    ['a.jsx', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['main.py', 'python'],
    ['shapes/square.py', 'python'],
    ['A.PY', 'python'],
    ['View.TSX', 'tsx'],
    ['types.d.ts', 'typescript'],
  ])('%s routes to %s', (path, language) => {
    expect(builtins().languageForPath(path)).toBe(language);
  });

  it.each(['Makefile', 'notes.txt', '.py', 'dir.py/README', 'a.', 'script'])(
    '%s routes nowhere',
    (path) => {
      expect(builtins().languageForPath(path)).toBeUndefined();
    },
  );

  it('accepts an extension with or without the dot, in any case', () => {
    const registry = builtins();
    expect(['py', '.py', 'PY', '.Py'].map((e) => registry.languageForExtension(e))).toEqual([
      'python',
      'python',
      'python',
      'python',
    ]);
  });
});

describe('no aliasing and no default (C-PARSE I6)', () => {
  it('an unregistered id or extension is undefined, never a fallback grammar', () => {
    const registry = builtins();
    expect(registry.get('js')).toBeUndefined();
    expect(registry.get('ts')).toBeUndefined();
    expect(registry.languageForExtension('.rb')).toBeUndefined();
  });

  it('an empty registry routes nothing', () => {
    expect(createLanguageRegistry().languageForPath('main.py')).toBeUndefined();
  });
});

describe('registration', () => {
  it('lists ids in registration order and returns each registration with normalized extensions', () => {
    const registry = createLanguageRegistry();
    registry.register(fake('one', ['ONE', '.Uno']));
    registry.register(fake('two', ['.two']));
    expect(registry.ids()).toEqual(['one', 'two']);
    expect(registry.get('one')?.extensions).toEqual(['.one', '.uno']);
  });

  it('refuses a duplicate id and an extension another language claims, changing nothing', () => {
    const registry = createLanguageRegistry();
    registry.register(fake('one', ['.one']));
    expect(registry.register(fake('one', ['.other']))).toEqual({
      ok: false,
      reason: 'duplicate-id',
      id: 'one',
    });
    expect(registry.register(fake('two', ['.two', '.ONE']))).toEqual({
      ok: false,
      reason: 'extension-claimed',
      extension: '.one',
      by: 'one',
    });
    expect(registry.ids()).toEqual(['one']);
    expect(registry.languageForExtension('.two')).toBeUndefined();
    expect(registry.languageForExtension('.other')).toBeUndefined();
  });

  it('refuses every registration after freeze()', () => {
    const registry = createLanguageRegistry();
    expect(registry.frozen).toBe(false);
    registry.freeze();
    expect(registry.frozen).toBe(true);
    expect(registry.register(fake('late', ['.late']))).toEqual({ ok: false, reason: 'frozen' });
    expect(registry.ids()).toEqual([]);
  });

  it('the builtins are python, typescript, tsx and javascript with their root node types', () => {
    const registry = builtins();
    expect(registry.ids().map((id) => [id, registry.get(id)?.rootNodeType])).toEqual([
      ['python', 'module'],
      ['typescript', 'program'],
      ['tsx', 'program'],
      ['javascript', 'program'],
    ]);
  });
});
