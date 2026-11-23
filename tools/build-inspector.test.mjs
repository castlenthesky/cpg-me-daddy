// U2b.1 part 2b (BMO-35, owner decision 7a): tools/build-inspector.mjs, the port of 21754b4:esbuild.js.
// The page bundle is one iife for the browser at es2022 (11-salvage.yaml:144), resolves @cpg/model
// from source so it never depends on tsc -b ordering, and runs under the shell's CSP: no eval and
// nothing left to load at runtime (C-EXT I-27: no unsafe-eval, everything bundled).
// One build without options writes the real default outfile; it is removed afterwards unless a
// bundle was already there.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInspectorPage, DEFAULT_OUTFILE } from './build-inspector.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'tools', 'build-inspector.mjs');
const IIFE_START = /^(?:"use strict";\s*)?\(\(\)\s*=>\s*\{/;
// Inside the repository (dist is git-ignored), so a cwd-relative resolution lands somewhere else.
const CLI_DEV = `apps/inspector/dist/build-inspector-test-${String(process.pid)}/graph.js`;

let dir = '';
let elsewhere = '';
const files = {
  dev: '',
  prod: '',
  cliDev: '',
  cliProd: '',
  defaulted: join(REPO, DEFAULT_OUTFILE),
};
const results = {
  dev: { inputs: [], warnings: -1 },
  prod: { inputs: [], warnings: -1 },
  defaulted: { inputs: [], warnings: -1 },
};
const cli = { dev: { status: -1, out: '' }, prod: { status: -1, out: '' } };
let defaultedExisted = false;

const runCli = (args, cwd) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'build-inspector-'));
  elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  for (const name of ['dev', 'prod', 'cliProd']) files[name] = join(dir, name, 'graph.js');
  files.cliDev = join(REPO, CLI_DEV);
  defaultedExisted = existsSync(files.defaulted);
  results.dev = await buildInspectorPage({ outfile: files.dev });
  results.prod = await buildInspectorPage({ outfile: files.prod, production: true });
  results.defaulted = await buildInspectorPage();
  cli.prod = runCli(['--production', '--outfile', files.cliProd], REPO);
  // Relative to the repository root, run from elsewhere: resolving against cwd would miss.
  cli.dev = runCli(['--outfile', CLI_DEV], elsewhere);
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  rmSync(dirname(join(REPO, CLI_DEV)), { recursive: true, force: true });
  if (!defaultedExisted) {
    rmSync(files.defaulted, { force: true });
    rmSync(`${files.defaulted}.map`, { force: true });
  }
});

const read = (file) => readFileSync(file, 'utf8');

const expectDevelopment = (file) => {
  const code = read(file);
  expect(code).toMatch(IIFE_START);
  expect(code).not.toMatch(/^(?:import|export)\b/m);
  expect(code).toMatch(/\n\}\)\(\);\n/);
  expect(code).toContain('//# sourceMappingURL=graph.js.map');
  expect(existsSync(`${file}.map`)).toBe(true);
};

const expectProduction = (file) => {
  const code = read(file);
  expect(code).toMatch(IIFE_START);
  expect(code).not.toContain('sourceMappingURL');
  expect(existsSync(`${file}.map`)).toBe(false);
  expect(statSync(file).size).toBeLessThan(statSync(files.dev).size * 0.75);
};

describe('buildInspectorPage', () => {
  it('writes to apps/inspector/dist/page/graph.js by default (what part 3 serves)', () => {
    expect(DEFAULT_OUTFILE).toBe('apps/inspector/dist/page/graph.js');
    expectDevelopment(files.defaulted);
    expect(results.defaulted.warnings).toBe(0);
  });

  it('bundles with no warnings', () => {
    expect(results.dev.warnings).toBe(0);
    expect(results.prod.warnings).toBe(0);
  });

  it('emits one iife with a sourcemap beside it', () => {
    expect(existsSync(files.dev)).toBe(true);
    expectDevelopment(files.dev);
  });

  it('minifies with no sourcemap under production (review a9)', () => {
    expect(existsSync(files.prod)).toBe(true);
    expectProduction(files.prod);
  });

  it('bundles the page entry, cosmos.gl and @cpg/model from source, never from dist', () => {
    const { inputs } = results.dev;
    expect(inputs).toContain('apps/inspector/src/graph-page.ts');
    expect(inputs).toContain('apps/inspector/src/graph-app.ts');
    expect(inputs).toContain('packages/model/src/index.ts');
    expect(inputs.some((p) => /(?:^|\/)node_modules\/@cosmos\.gl\/graph\//.test(p))).toBe(true);
    expect(inputs.filter((p) => p.startsWith('packages/model/dist/'))).toEqual([]);
    expect(inputs.filter((p) => p.startsWith('apps/inspector/dist/'))).toEqual([]);
    expect(results.defaulted.inputs).toEqual(inputs);
  });
});

describe('node tools/build-inspector.mjs', () => {
  it('--production --outfile <path>: exits 0, no warnings, minified', () => {
    expect({ status: cli.prod.status, out: cli.prod.out }).toMatchObject({ status: 0 });
    expect(cli.prod.out).not.toMatch(/\[WARNING\]/);
    expectProduction(files.cliProd);
  });

  it('--outfile <relative>: resolves against the repository root, with a sourcemap (review a9, b1)', () => {
    expect({ status: cli.dev.status, out: cli.dev.out }).toMatchObject({ status: 0 });
    expect(cli.dev.out).not.toMatch(/\[WARNING\]/);
    expectDevelopment(files.cliDev);
    expect(existsSync(join(elsewhere, CLI_DEV))).toBe(false);
  });

  // Post-implementation (sabotage #16): a failed build must fail the command, or a script that
  // chains `build:inspector` would serve a stale bundle.
  it('exits 1 when the build fails (an outfile under a regular file)', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const r = runCli(['--outfile', join(blocker, 'graph.js')], REPO);
    expect(r.out).toContain('Failed to create output directory');
    expect(r.status).toBe(1);
  });
});

describe.each([
  ['the development bundle', () => files.dev],
  ['the production bundle', () => files.prod],
  ['the CLI development bundle', () => files.cliDev],
  ['the CLI production bundle', () => files.cliProd],
])('%s, under the shell CSP (I-27)', (_name, file) => {
  it('never evaluates a string (no unsafe-eval)', () => {
    const code = read(file());
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bFunction\s*\(/);
  });

  it('leaves nothing to load: no require, no dynamic require and no dynamic import', () => {
    const code = read(file());
    expect(code).not.toMatch(/\brequire\s*\(/);
    // Review a10: a node-platform build calls esbuild's __require("crypto"); minified, only the
    // shim's error text survives.
    expect(code).not.toMatch(/__require\(\s*["']/);
    expect(code).not.toContain('Dynamic require of');
    expect(code).not.toMatch(/\bimport\s*\(/);
  });
});
