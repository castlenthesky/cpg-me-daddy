// U2b.1 part 2b (BMO-35, owner decision 7a): tools/build-inspector.mjs, the port of 21754b4:esbuild.js.
// The page bundle is one iife for the browser at es2022 (11-salvage.yaml:144), resolves @cpg/model
// from source so it never depends on tsc -b ordering, and runs under the shell's CSP: no eval and
// nothing left to load at runtime (C-EXT I-27: no unsafe-eval, everything bundled).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInspectorPage, DEFAULT_OUTFILE } from './build-inspector.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'tools', 'build-inspector.mjs');
const IIFE_START = /^(?:"use strict";\s*)?\(\(\)\s*=>\s*\{/;

let dir = '';
let dev = { inputs: [], warnings: -1 };
let devFile = '';
let cli = { status: -1, out: '' };
let prodFile = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'build-inspector-'));
  devFile = join(dir, 'dev', 'graph.js');
  prodFile = join(dir, 'prod', 'graph.js');
  dev = await buildInspectorPage({ outfile: devFile });
  const r = spawnSync('node', [SCRIPT, '--production', '--outfile', prodFile], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  cli = { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const read = (file) => readFileSync(file, 'utf8');

describe('buildInspectorPage', () => {
  it('writes to apps/inspector/dist/page/graph.js by default (what part 3 serves)', () => {
    expect(DEFAULT_OUTFILE).toBe('apps/inspector/dist/page/graph.js');
  });

  it('bundles with no warnings', () => {
    expect(dev.warnings).toBe(0);
  });

  it('emits one iife with a sourcemap beside it', () => {
    const code = read(devFile);
    expect(code).toMatch(IIFE_START);
    expect(code).not.toMatch(/^(?:import|export)\b/m);
    expect(code).toMatch(/\n\}\)\(\);\n/);
    expect(code).toContain('//# sourceMappingURL=graph.js.map');
    expect(existsSync(`${devFile}.map`)).toBe(true);
  });

  it('bundles the page entry, cosmos.gl and @cpg/model from source, never from dist', () => {
    expect(dev.inputs).toContain('apps/inspector/src/graph-page.ts');
    expect(dev.inputs).toContain('apps/inspector/src/graph-app.ts');
    expect(dev.inputs).toContain('packages/model/src/index.ts');
    expect(dev.inputs.some((p) => /(?:^|\/)node_modules\/@cosmos\.gl\/graph\//.test(p))).toBe(true);
    expect(dev.inputs.filter((p) => p.startsWith('packages/model/dist/'))).toEqual([]);
    expect(dev.inputs.filter((p) => p.startsWith('apps/inspector/dist/'))).toEqual([]);
  });
});

describe('node tools/build-inspector.mjs --production', () => {
  it('exits 0 with no warnings', () => {
    expect({ status: cli.status, out: cli.out }).toMatchObject({ status: 0 });
    expect(cli.out).not.toMatch(/\[WARNING\]/);
  });

  it('minifies, with no sourcemap', () => {
    const code = read(prodFile);
    expect(code).toMatch(IIFE_START);
    expect(code).not.toContain('sourceMappingURL');
    expect(existsSync(`${prodFile}.map`)).toBe(false);
    expect(statSync(prodFile).size).toBeLessThan(statSync(devFile).size * 0.75);
  });
});

describe.each([
  ['the development bundle', () => devFile],
  ['the production bundle', () => prodFile],
])('%s, under the shell CSP (I-27)', (_name, file) => {
  it('never evaluates a string (no unsafe-eval)', () => {
    const code = read(file());
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bFunction\s*\(/);
  });

  it('leaves nothing to load: no require and no dynamic import', () => {
    const code = read(file());
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });
});
