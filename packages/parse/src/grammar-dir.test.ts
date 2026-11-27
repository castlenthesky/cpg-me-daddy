// C-PARSE I10 and I11: explicit > CPG_GRAMMAR_DIR > package anchor, from the request alone.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrammarDirOutcome, GrammarDirRequest, GrammarDirVia } from './contract';
import { resolveGrammarDir } from './grammar-dir';
import { BUILTIN_LANGUAGES } from './registry';

const PKG = 'grammar-pkg';
const PKG_JSON = '/opt/modules/grammar-pkg/package.json';
const ANCHOR = '/opt/modules/grammar-pkg/wasm';
const EXPLICIT = '/from/explicit';
const ENV_DIR = '/from/env';

const env = (value: string) => ({ HOME: '/home/u', CPG_GRAMMAR_DIR: value });
const found = (dir: string, via: GrammarDirVia): GrammarDirOutcome => ({ ok: true, dir, via });
const relativeJson = (): string => 'node_modules/grammar-pkg/package.json';
// The cause does not repeat the package name, so the message must add it.
const missing = (): string => {
  throw new Error('ENOENT');
};
const nodeResolve = (pkg: string): string => require.resolve(`${pkg}/package.json`);

/** Resolves PKG, recording each package the anchor is asked for. */
function locate(over: Partial<GrammarDirRequest> = {}, packageJson = (): string => PKG_JSON) {
  const asked: string[] = [];
  const outcome = resolveGrammarDir({
    packageName: PKG,
    resolvePackageJson: (pkg) => {
      asked.push(pkg);
      return packageJson();
    },
    ...over,
  });
  return { outcome, asked };
}

afterEach(() => vi.unstubAllEnvs());

describe('precedence, reported in via (I11)', () => {
  it.each([
    ['explicit beats env', { explicit: EXPLICIT, env: env(ENV_DIR) }, EXPLICIT, 'explicit'],
    ['env beats the package', { env: env(ENV_DIR) }, ENV_DIR, 'CPG_GRAMMAR_DIR'],
    ['empty explicit is unset', { explicit: '', env: env(ENV_DIR) }, ENV_DIR, 'CPG_GRAMMAR_DIR'],
  ] as const)('%s, and the package is never resolved', (_name, over, dir, via) => {
    expect(locate(over)).toEqual({ outcome: found(dir, via), asked: [] });
  });

  it.each([
    ['no override', {}],
    ['an empty explicit and env value', { explicit: '', env: env('') }],
    ['other variables only', { env: { HOME: '/home/u', GRAMMAR_DIR: ENV_DIR } }],
  ])('%s: the package anchor, <dir of package.json>/wasm', (_name, over) => {
    expect(locate(over)).toEqual({ outcome: found(ANCHOR, 'package-anchor'), asked: [PKG] });
  });
});

describe('the request is all it reads (I10)', () => {
  it('never reads process.env: CPG_GRAMMAR_DIR in the process is ignored', () => {
    vi.stubEnv('CPG_GRAMMAR_DIR', ENV_DIR);
    expect(locate().outcome).toEqual(found(ANCHOR, 'package-anchor'));
  });

  it.each([
    ['a relative explicit', { explicit: 'grammars', env: env(ENV_DIR) }, 'explicit'],
    ['a relative CPG_GRAMMAR_DIR', { env: env('./wasm') }, 'CPG_GRAMMAR_DIR'],
  ] as const)('%s is refused, not resolved against the cwd or passed over', (_n, over, via) => {
    const { outcome, asked } = locate(over);
    expect([outcome.ok, outcome.via, asked]).toEqual([false, via, []]);
  });

  it('a relative package.json from the host is refused', () => {
    expect(locate({}, relativeJson).outcome).toMatchObject({ ok: false, via: 'package-anchor' });
  });

  it('a package that cannot be resolved is an outcome naming it and CPG_GRAMMAR_DIR, not a throw', () => {
    const { outcome } = locate({}, missing);
    expect(outcome).toMatchObject({ ok: false, via: 'package-anchor' });
    const message = outcome.ok ? '' : outcome.message;
    expect([message.includes(PKG), message.includes('CPG_GRAMMAR_DIR')]).toEqual([true, true]);
  });
});

describe('the real package anchor', () => {
  it('holds every builtin grammar, found by its registration package name', () => {
    const absent = BUILTIN_LANGUAGES.filter(({ grammar }) => {
      const at = resolveGrammarDir({
        packageName: grammar.packageName,
        resolvePackageJson: nodeResolve,
      });
      return !(at.ok && at.via === 'package-anchor' && existsSync(join(at.dir, grammar.wasmFile)));
    });
    expect(absent.map((r) => r.id)).toEqual([]);
  });
});
