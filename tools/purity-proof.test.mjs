// U2c.3 (BMO-48, CS-6): tools/purity-proof.mjs under plain node. Each case builds a throwaway root
// with a fake front door (apps/cli/dist/main.js) and engine (packages/engine/dist), shaped like the
// built CJS output, and spawns the script on it. The real repository's run is the check:purity gate.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'tools', 'purity-proof.mjs');
const PLANT = 'packages/engine/out/__purity_plant.js';
const roots = [];

// The front door loads the engine with a CJS require, as tsc emits main.ts, and sets
// process.exitCode after the asynchronous dry run, as main.ts does. The run finishes only after real
// async I/O and a timer, so a proof that judges any earlier than beforeExit judges too early.
const bin = (extra = '') =>
  "const engine = require('../../../packages/engine/dist/index.js');\n" +
  `const { readdir } = require('node:fs/promises');\n${extra}\n` +
  "console.log('argv ' + JSON.stringify(process.argv.slice(2)));\n" +
  "const names = ['CPG_WORKSPACE', 'CPG_HOST', 'CPG_PORT', 'CPG_GRAPH'];\n" +
  "console.log('env ' + JSON.stringify(names.map((n) => process.env[n] ?? null)));\n" +
  'readdir(__dirname)\n' +
  '  .then(() => new Promise((done) => setTimeout(done, 10)))\n' +
  '  .then(() => engine.index())\n' +
  '  .then((code) => {\n    process.exitCode = code;\n  });\n';
const engine = (extra = '', code = 0) =>
  `const walker = require('./walker.js');\n${extra}\n` +
  `exports.index = () => {\n  walker.walk();\n  return ${code};\n};\n`;
const walker = (extra = '', atRun = '') =>
  `const { readdirSync } = require('node:fs');\n${extra}\n` +
  `exports.walk = () => {\n${atRun}\n  return readdirSync(__dirname).length;\n};\n`;
const tryRequire = (request) => `try {\n  require('${request}');\n} catch {}\n`;

const ESM_ENGINE = {
  'packages/engine/package.json': '{ "type": "module" }\n',
  'packages/engine/dist/index.js':
    "import { walk } from './walker.js';\nexport function index() {\n  walk();\n  return 0;\n}\n",
  'packages/engine/dist/walker.js':
    "import { readdirSync } from 'node:fs';\nexport function walk() {\n  return readdirSync('.').length;\n}\n",
};

// files: path -> text; null removes a default.
function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'purity-proof-'));
  roots.push(root);
  const all = {
    'apps/cli/dist/main.js': bin(),
    'packages/engine/dist/index.js': engine(),
    'packages/engine/dist/walker.js': walker(),
    'fixtures/ladder/00-one-text-file/ws/notes.txt': 'hello\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// NODE_OPTIONS is dropped: an IDE or debugger preload would add modules to the child's list.
function proof(root, args = [], nodeArgs = [], env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [...nodeArgs, SCRIPT, ...args, root], {
    encoding: 'utf8',
    env: childEnv,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// Preloads that leave Module._load impossible to replace before the script runs.
const BROKEN_LOAD = {
  'read-only':
    "Object.defineProperty(Module, '_load', { value: Module._load, writable: false, configurable: false });",
  deleted: 'delete Module._load;',
  'a setter that ignores writes':
    "const load = Module._load;\nObject.defineProperty(Module, '_load', { get: () => load, set() {} });",
};
function brokenLoad(root, kind = 'read-only') {
  const file = join(root, 'break-load.mjs');
  writeFileSync(file, `import Module from 'node:module';\n${BROKEN_LOAD[kind]}\n`);
  return ['--import', pathToFileURL(file).href];
}

const listing = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true }).toSorted((a, b) => a.localeCompare(b))
    : [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('purity-proof on a clean front door and engine', () => {
  it('runs the bin in-process as `cpg index --dry-run <root>/fixtures/ladder` and passes', () => {
    const root = tree();
    const { status, out } = proof(root);
    const fixture = join(realpathSync(root), 'fixtures', 'ladder');
    expect(out).toContain(`argv ${JSON.stringify(['index', '--dry-run', fixture])}`);
    expect(out).toMatch(/^purity-proof: ok/m);
    expect(status).toBe(0);
  });

  it('prints the module list: one line per owner with its distinct-file count', () => {
    const root = tree({
      // repeat loads, fs as node:fs, a bare builtin, an unscoped and a scoped package
      'packages/engine/dist/index.js': engine(
        "require('./walker.js');\nrequire('fs');\nrequire('path');\nrequire('pkg');\nrequire('@scope/pkg/lib/x.js');",
      ),
      'node_modules/pkg/index.js': "require('./other.js');\n",
      'node_modules/pkg/other.js': '\n',
      'node_modules/@scope/pkg/lib/x.js': '\n',
    });
    const { status, out } = proof(root);
    const owners = out.split('\n').filter((line) => line.startsWith('  '));
    // exactly these: fs and node:fs are one module (post-implementation, a sabotage survivor)
    expect(owners.toSorted((a, b) => a.localeCompare(b))).toEqual(
      [
        'apps/cli (1)',
        'packages/engine (2)',
        'node:fs (1)',
        'node:fs/promises (1)',
        'node:path (1)',
        'pkg (2)',
        '@scope/pkg (1)',
      ]
        .map((line) => `  ${line}`)
        .toSorted((a, b) => a.localeCompare(b)),
    );
    expect(status).toBe(0);
  });

  it('drops CPG_WORKSPACE, CPG_HOST, CPG_PORT and CPG_GRAPH before the bin reads its config', () => {
    const env = { CPG_WORKSPACE: '/elsewhere', CPG_HOST: 'h', CPG_PORT: 'x', CPG_GRAPH: 'g' };
    const { status, out } = proof(tree(), [], [], env);
    expect(out).toContain('env [null,null,null,null]');
    expect(status).toBe(0);
  });

  it('resolves a symlinked root to its real path, the form Node reports module filenames in', () => {
    const root = tree();
    const dir = mkdtempSync(join(tmpdir(), 'purity-link-'));
    roots.push(dir);
    const link = join(dir, 'root');
    symlinkSync(root, link, 'dir');
    const { status, out } = proof(link);
    expect(out).toMatch(/^purity-proof: ok/m);
    expect(status).toBe(0);
  });

  it.each(['vscode-languageserver', '@vscode/codicons'])(
    'does not count %s as vscode (the request must match /^vscode(\\/|$)/)',
    (request) => {
      const { status, out } = proof(
        tree({ 'packages/engine/dist/index.js': engine(tryRequire(request)) }),
      );
      expect(out).toMatch(/^purity-proof: ok/m);
      expect(status).toBe(0);
    },
  );
});

describe('purity-proof fails on a forbidden load, naming the request and the requesting file', () => {
  it.each([
    ['vscode from a nested engine file', 'packages/engine/dist/walker.js', 'vscode'],
    ['a vscode subpath', 'packages/engine/dist/index.js', 'vscode/lib/api'],
    ['the MCP SDK', 'packages/engine/dist/index.js', '@modelcontextprotocol/sdk/server/index.js'],
    ['a DOM implementation (jsdom)', 'packages/engine/dist/walker.js', 'jsdom'],
    ['a DOM implementation subpath', 'packages/engine/dist/walker.js', 'jsdom/lib/api'],
    ['a DOM implementation (happy-dom)', 'packages/engine/dist/index.js', 'happy-dom'],
    ['a DOM implementation (linkedom)', 'packages/engine/dist/index.js', 'linkedom'],
    ['vscode from the front door itself', 'apps/cli/dist/main.js', 'vscode'],
  ])('%s', (_name, file, request) => {
    const build = { 'apps/cli/dist/main.js': bin, 'packages/engine/dist/index.js': engine };
    const make = build[file] ?? walker;
    const { status, out } = proof(tree({ [file]: make(tryRequire(request)) }));
    expect(out).toContain(`"${request}" requested by ${file}`);
    expect(out).not.toMatch(/^purity-proof: ok/m);
    expect(status).toBe(1);
  });

  it('keeps the trap on for the whole run: a require made during the dry run is caught', () => {
    const root = tree({ 'packages/engine/dist/walker.js': walker('', tryRequire('vscode')) });
    const { status, out } = proof(root);
    expect(out).toContain('"vscode" requested by packages/engine/dist/walker.js');
    expect(status).toBe(1);
  });

  it('names the violation when the forbidden require crashes the engine while it loads', () => {
    const root = tree({ 'packages/engine/dist/index.js': engine("require('vscode');") });
    const { status, out } = proof(root);
    expect(out).toContain('"vscode" requested by packages/engine/dist/index.js');
    expect(status).toBe(1);
  });

  it.each(['document', 'window'])('fails when a DOM global (%s) appears during the run', (name) => {
    const root = tree({ 'packages/engine/dist/walker.js': walker(`globalThis.${name} = {};`) });
    const { status, out } = proof(root);
    expect(out).toMatch(/DOM global/);
    expect(status).toBe(1);
  });
});

describe('purity-proof fails loudly when its own run would prove nothing', () => {
  it('fails when the bin is not built', () => {
    const { status, out } = proof(tree({ 'apps/cli/dist/main.js': null }));
    expect(out).toMatch(/apps\/cli\/dist\/main\.js is not built/);
    expect(status).toBe(1);
  });

  it('fails when the dry run exits non-zero', () => {
    const { status, out } = proof(tree({ 'packages/engine/dist/index.js': engine('', 2) }));
    expect(out).toMatch(/exited 2/);
    expect(out).not.toMatch(/^purity-proof: ok/m);
    expect(status).toBe(1);
  });

  it('fails when the engine loads as native ESM, whose imports Module._load never sees', () => {
    const { status, out } = proof(tree(ESM_ENGINE));
    expect(out).toMatch(/did not load through Module\._load/);
    expect(out).not.toMatch(/^purity-proof: ok/m);
    expect(status).toBe(1);
  });

  it.each(Object.keys(BROKEN_LOAD))('fails when Module._load cannot be replaced (%s)', (kind) => {
    const root = tree();
    const { status, out } = proof(root, [], brokenLoad(root, kind));
    expect(out).toMatch(/cannot install/);
    expect(out).not.toMatch(/^purity-proof: ok/m);
    expect(status).toBe(1);
  });
});

describe('purity-proof --plant (anti-vacuity)', () => {
  it('plants a vscode import in packages/engine, asserts the trap fired, and removes the plant', () => {
    const root = tree();
    const { status, out } = proof(root, ['--plant']);
    expect(out).toContain(`"vscode" requested by ${PLANT}`);
    expect(out).toMatch(/^purity-proof: ok.*trap fired/m);
    expect(existsSync(join(root, PLANT))).toBe(false);
    expect(existsSync(join(root, 'packages/engine/out'))).toBe(false);
    expect(status).toBe(0);
  });

  it('leaves a packages/engine/out it did not create, and everything already in it', () => {
    const root = tree({ 'packages/engine/out/keep.txt': 'mine\n' });
    const { status } = proof(root, ['--plant']);
    expect(listing(join(root, 'packages/engine/out'))).toEqual(['keep.txt']);
    expect(status).toBe(0);
  });

  it('fails, and removes the plant, when the engine is native ESM (the plant cannot fire)', () => {
    const root = tree(ESM_ENGINE);
    const { status, out } = proof(root, ['--plant']);
    expect(out).toMatch(/did not fire/);
    // loading the plant must not itself count as the engine loading through Module._load
    expect(out).toMatch(/did not load through Module\._load/);
    expect(out).not.toMatch(/^purity-proof: ok/m);
    expect(existsSync(join(root, PLANT))).toBe(false);
    expect(status).toBe(1);
  });

  it('fails, and removes the plant, when the dry run exits non-zero', () => {
    const root = tree({ 'packages/engine/dist/index.js': engine('', 2) });
    const { status, out } = proof(root, ['--plant']);
    expect(out).toMatch(/exited 2/);
    expect(existsSync(join(root, PLANT))).toBe(false);
    expect(status).toBe(1);
  });

  it('fails, leaving no plant, when Module._load cannot be replaced', () => {
    const root = tree();
    const { status, out } = proof(root, ['--plant'], brokenLoad(root));
    expect(out).toMatch(/cannot install/);
    expect(existsSync(join(root, PLANT))).toBe(false);
    expect(status).toBe(1);
  });

  it('still fails on a real violation, which the plant does not excuse', () => {
    const root = tree({ 'packages/engine/dist/walker.js': walker(tryRequire('vscode')) });
    const { status, out } = proof(root, ['--plant']);
    expect(out).toContain('"vscode" requested by packages/engine/dist/walker.js');
    expect(status).toBe(1);
  });

  it('plants at a path this repository git-ignores, so the plant can never be committed', () => {
    const r = spawnSync('git', ['check-ignore', '-q', PLANT], { cwd: REPO });
    expect(r.status).toBe(0);
  });
});

describe('CI runs both modes', () => {
  it('check:purity runs the proof then --plant, and bun run check runs it after check:cli-bin', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:purity']).toBe(
      'node tools/purity-proof.mjs && node tools/purity-proof.mjs --plant',
    );
    expect(readFileSync(join(REPO, 'tools/check.mjs'), 'utf8')).toContain("'check:purity'");
    expect(readFileSync(join(REPO, 'turbo.json'), 'utf8')).toMatch(
      /"\/\/#check:purity":\s*\{[^{}]*"dependsOn":\s*\["\/\/#check:cli-bin"\]/,
    );
  });
});
