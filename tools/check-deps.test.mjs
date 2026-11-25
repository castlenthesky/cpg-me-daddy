// A rule nobody has seen fail is not a gate (L-31). Each case builds a throwaway
// repository, plants exactly one violation, and asserts check-deps rejects it
// with the right rule. The clean cases prove the gate is not vacuously red.
// The three tier violations U0.2.2 names are planted on the real tree by
// tools/prove-gates.mjs instead, so they are not repeated here.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-deps.mjs');
const roots = [];

function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const res = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  return { status: res.status, out: res.stdout + res.stderr };
}

const CLEAN = {
  'packages/model/src/index.ts': 'export const x = 1;\n',
  'apps/vscode/src/extension.ts':
    "import * as vscode from 'vscode';\nimport { x } from '@cpg/model';\nimport { join } from 'node:path';\n",
  'apps/cli/src/main.ts': "import { readFileSync } from 'fs';\nimport { x } from '@cpg/model';\n",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-deps passes a clean two-tier tree', () => {
  it('accepts the clean fixture, including apps/vscode importing its own SDK', () => {
    const { status, out } = run(CLEAN);
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it('does not read a quoted keyword inside a string as an import', () => {
    const { status, out } = run({
      ...CLEAN,
      'packages/model/src/messages.ts':
        "export const a = (xs: string[]) => `declared 'from' set [${xs.join(', ')}]`;\n" +
        "export const b = \"the 'import' and 'require' keywords\";\n",
    });
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it('lets packages/engine define createEngine, its tests and apps/* call it, and a comment name it', () => {
    const { status, out } = run({
      ...CLEAN,
      'packages/engine/src/engine.ts':
        '// createEngine() is the composition root\nexport function createEngine(config) {\n  return config;\n}\n',
      'packages/engine/src/engine.test.ts':
        "import { createEngine } from './engine';\ncreateEngine({});\n",
      'apps/cli/src/main.ts': "import { createEngine } from '@cpg/engine';\ncreateEngine({});\n",
      // a re-export and comments of every form name it without calling it
      'packages/engine/src/index.ts': "export { createEngine } from './engine';\n",
      'packages/sink/src/notes.ts':
        "import type { createEngine } from '@cpg/engine';\n// see createEngine() in apps/cli\n/* createEngine() wires\n * createEngine(config, deps) here\n */\nexport type E = typeof createEngine;\n",
    });
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it('lets packages/engine know more than one sibling', () => {
    const { status } = run({
      ...CLEAN,
      'packages/engine/src/index.ts': "import '@cpg/watch';\nimport '@cpg/parse';\n",
    });
    expect(status).toBe(0);
  });
});

describe('check-deps rejects every planted violation', () => {
  const cases = [
    [
      'side-effect vscode import in packages/foo',
      'packages/foo/src/probe.ts',
      "import 'vscode';\n",
      'host-sdk',
    ],
    [
      'double-quoted side-effect import in packages/foo',
      'packages/foo/src/probe.ts',
      'import "vscode";\n',
      'host-sdk',
    ],
    [
      'export * from vscode in packages/foo',
      'packages/foo/src/probe.ts',
      "export * from 'vscode';\n",
      'host-sdk',
    ],
    [
      'a multi-line import whose from is on a later line',
      'packages/foo/src/probe.ts',
      "import type {\n  Uri,\n}\n  from\n  'vscode';\n",
      'host-sdk',
    ],
    [
      'the MCP SDK in packages/foo',
      'packages/foo/src/probe.ts',
      "import { Server } from '@modelcontextprotocol/sdk/server';\n",
      'host-sdk',
    ],
    [
      'a DOM global in packages/foo',
      'packages/foo/src/probe.ts',
      'export const w = document.body;\n',
      'host-sdk',
    ],
    [
      'a vscode require in stale packages/foo/dist',
      'packages/foo/dist/probe.js',
      'const v = require("vscode");\n',
      'host-sdk',
    ],
    ['vscode in apps/cli', 'apps/cli/src/probe.ts', "import 'vscode';\n", 'app-tier'],
    [
      'an arbitrary npm package in apps/cli',
      'apps/cli/src/probe.ts',
      "import chalk from 'chalk';\n",
      'app-tier',
    ],
    [
      'a deep import in apps/vscode',
      'apps/vscode/src/probe.ts',
      "import { x } from '@cpg/model/dist/x';\n",
      'deep-import',
    ],
    [
      'a runtime dep in @cpg/model',
      'packages/model/src/probe.ts',
      "import yaml from 'yaml';\n",
      'model-zero-deps',
    ],
    [
      'a createEngine() call in packages/foo',
      'packages/foo/src/probe.ts',
      "import { createEngine } from '@cpg/engine';\nexport const e = createEngine({}, { sinks: [] });\n",
      'engine-call-site',
    ],
    [
      'a createEngine() call next to its definition in packages/engine/src/engine.ts',
      'packages/engine/src/engine.ts',
      'export function createEngine(c) {\n  return c;\n}\nexport const e = createEngine({});\n',
      'engine-call-site',
    ],
    [
      'a createEngine() call inside packages/engine itself',
      'packages/engine/src/boot.ts',
      "import { createEngine } from './engine';\nexport const e = createEngine ({}, { sinks: [] });\n",
      'engine-call-site',
    ],
    [
      'a composition root in packages/foo',
      'packages/foo/src/probe.ts',
      "import '@cpg/watch';\nimport '@cpg/parse';\n",
      'composition-root',
    ],
    [
      'a NUL byte',
      'packages/foo/src/probe.ts',
      `export const s = 1;${String.fromCharCode(0)}\n`,
      'nul-byte',
    ],
  ];

  it.each(cases)('%s', (_name, path, text, rule) => {
    const { status, out } = run({ ...CLEAN, [path]: text });
    expect(status).toBe(1);
    expect(out).toContain(`[${rule}]`);
  });
});

const contract = (text) => ({ ...CLEAN, 'packages/resolve/src/contract.ts': text });

describe('rule 7: seam contract.ts imports types only', () => {
  const MODEL = "import type { WorkspacePath } from '@cpg/model';\n";

  it.each([
    ['multi-line import type', "import type {\n  A,\n  B,\n} from '@cpg/model';\n"],
    ['import type * as N', "import type * as M from '@cpg/model';\n"],
    ['export type { } from', "export type { A } from '@cpg/model';\n"],
    ['export type * from', "export type * from '@cpg/model';\n"],
    [
      'two consecutive import types with no semicolons',
      "import type { A } from '@cpg/model'\nimport type { B } from '@cpg/model'\nexport type R = A | B\n",
    ],
    ['export type * as N from', "export type * as N from '@cpg/model';\n"],
    ['import type with no semicolon', "import type { A } from '@cpg/model'\nexport type R = A\n"],
    // U2c.3: the scanner skips comments, so a specifier inside one is no longer a false positive,
    // and a statement is type-only by the parse tree, not by a regex over its text
    [
      'a quoted specifier inside a comment',
      "// see import { x } from '@cpg/model'\nexport type R = 1;\n",
    ],
    ['an import type with a comment inside', "import type /* c */ { A } from '@cpg/model';\n"],
    [
      'a disallowed import type inside a block comment',
      "/*\nimport type { X } from '@cpg/sink';\n*/\nexport type R = 1;\n",
    ],
  ])('accepts %s', (_name, text) => {
    const { status, out } = run(contract(text));
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it('applies rule 7 to packages/watch/src/contract.ts too (not scoped to resolve)', () => {
    const { status, out } = run({
      ...CLEAN,
      'packages/watch/src/contract.ts':
        "import { x } from '@cpg/model';\nexport type R = typeof x;\n",
    });
    expect(status).toBe(1);
    expect(out).toContain('[contract-types-only]');
  });

  it('exempts apps/**/contract.ts from rule 7 (apps may load anything their tier allows)', () => {
    const { status } = run({
      ...CLEAN,
      'apps/cli/src/contract.ts': "import { x } from '@cpg/model';\nexport const y = x;\n",
    });
    expect(status).toBe(0);
  });

  it('accepts a value import of @cpg/model in a NON-contract file (scoped by basename)', () => {
    const { status } = run({
      ...CLEAN,
      'packages/resolve/src/chain.ts':
        "import { WORKSPACE_ROOT } from '@cpg/model';\nexport const r = WORKSPACE_ROOT;\n",
    });
    expect(status).toBe(0);
  });

  it.each([
    [
      'a value import',
      "import { WORKSPACE_ROOT } from '@cpg/model';\nexport type R = typeof WORKSPACE_ROOT;\n",
    ],
    ['an inline { type X }', "import { type WorkspacePath } from '@cpg/model';\n"],
    ['require()', "const m = require('@cpg/model');\n"],
    ['import()', "export type T = Promise<unknown>;\nconst m = import('@cpg/model');\n"],
    ['a bare side-effect import', "import '@cpg/model';\n"],
    ['a braced value re-export', "export { X } from '@cpg/model';\n"],
    ['a namespace value import', "import * as M from '@cpg/model';\nexport type R = typeof M;\n"],
    ['a default value import', "import M from '@cpg/model';\nexport type R = typeof M;\n"],
    ['export * (a value re-export)', "export * from '@cpg/model';\n"],
    ['import type from a disallowed package', "import type { X } from '@cpg/sink';\n"],
    ['import type from a relative path', "import type { X } from './local';\n"],
    ['an import type node in a type position', "export type R = import('@cpg/model').X;\n"],
  ])('rejects %s', (_name, text) => {
    const { status, out } = run(contract(text));
    expect(status).toBe(1);
    expect(out).toContain('[contract-types-only]');
  });

  it.each([
    ['a disallowed package', "import type { X } from '@cpg/sink';\n", /imports "@cpg\/sink"/],
    ['a relative path', "import type { X } from './local';\n", /imports ".\/local"/],
    ['a value import', "import { X } from '@cpg/model';\n", /loads "@cpg\/model" at runtime/],
  ])('names the right violation for %s', (_name, text, message) => {
    const { out } = run(contract(text));
    expect(out).toMatch(message);
  });

  it.each([
    ["export type R = Foo\nimport { WORKSPACE_ROOT } from '@cpg/model'\n"],
    ["interface I { a: string }\nimport { X } from '@cpg/model'\n"],
  ])('rejects the semicolon-less bypass on line 2: %j', (text) => {
    const { status, out } = run(contract(text));
    expect(status).toBe(1);
    expect(out).toMatch(/contract\.ts:2 +\[contract-types-only\]/);
  });

  it('pins the line of a disallowed multi-line import type to its statement start', () => {
    const { out } = run(contract(MODEL + "import type {\n  A,\n  B,\n} from '@cpg/sink';\n"));
    expect(out).toMatch(/contract\.ts:2 +\[contract-types-only\].*@cpg\/sink/);
  });

  it('reports a runtime import after a multi-line type import on its true line', () => {
    const { out } = run(
      contract(
        "import type {\n  A,\n  B,\n} from '@cpg/model';\nimport { X } from '@cpg/model';\n",
      ),
    );
    expect(out).toMatch(/contract\.ts:5 +\[contract-types-only\]/);
  });
});

// U2c.3 (BMO-48): specifiers come from ts.preProcessFile and the parse tree, never a regex. A regex
// reads a specifier in a comment or a string as an import, and misses one written around a comment
// or as a template literal. preProcessFile alone misses three forms (marked below) that the parse
// tree sees, so the scanner needs both.
describe('check-deps finds specifiers with the TypeScript scanner, in packages/** and apps/**', () => {
  it.each([
    [
      'an import with a comment before its specifier',
      'packages/foo/src/probe.ts',
      "import /* c */ 'vscode';\n",
      'host-sdk',
    ],
    [
      'an export * with a comment after its from',
      'packages/foo/src/probe.ts',
      "export * from /* c */ 'vscode';\n",
      'host-sdk',
    ],
    [
      'a require with a comment before its parenthesis',
      'packages/foo/src/probe.js',
      "require /* c */ ('vscode');\n",
      'host-sdk',
    ],
    [
      'a dynamic import of a template literal',
      'packages/foo/src/probe.ts',
      'export const m = import(`vscode`);\n',
      'host-sdk',
    ],
    [
      'a require of a template literal in stale dist',
      'packages/foo/dist/probe.js',
      'require(`vscode`);\n',
      'host-sdk',
    ],
    // preProcessFile alone misses this one and the next two
    [
      'export type * as N from',
      'packages/foo/src/probe.ts',
      "export type * as V from 'vscode';\n",
      'host-sdk',
    ],
    [
      'a require inside a template substitution',
      'packages/foo/src/probe.ts',
      "export const s = `${require('vscode')}`;\n",
      'host-sdk',
    ],
    [
      'a require after a regex literal holding a quote',
      'packages/foo/src/probe.ts',
      "const r = /'/; require('vscode');\nexport { r };\n",
      'host-sdk',
    ],
    // after a regex literal holding a backtick preProcessFile sees nothing, so only the parse tree
    // can find these two
    [
      'import x = require() after a regex literal holding a backtick',
      'packages/foo/src/probe.ts',
      "const r = /`/;\nimport v = require('vscode');\nexport { r, v };\n",
      'host-sdk',
    ],
    [
      'an import type node after a regex literal holding a backtick',
      'packages/foo/src/probe.ts',
      "const r = /`/;\nexport type R = import('vscode').Uri;\nexport { r };\n",
      'host-sdk',
    ],
    // post-implementation (sabotage survivors): the parse tree's import() and template-literal
    // handling, and the one form only preProcessFile sees
    [
      'a dynamic import after a regex literal holding a backtick',
      'packages/foo/src/probe.ts',
      "const r = /`/;\nexport const m = import('vscode');\n",
      'host-sdk',
    ],
    [
      'a template-literal require after a regex literal holding a backtick',
      'packages/foo/src/probe.js',
      'const r = /`/;\nrequire(`vscode`);\n',
      'host-sdk',
    ],
    [
      'an AMD define dependency',
      'packages/foo/src/probe.js',
      "define(['vscode'], function (v) {\n  return v;\n});\n",
      'host-sdk',
    ],
    [
      'an app import with a comment before its specifier (apps/inspector)',
      'apps/inspector/src/probe.ts',
      "import /* c */ 'chalk';\n",
      'app-tier',
    ],
    [
      'a nested app file requiring a template literal (apps/mcp)',
      'apps/mcp/src/deep/nested/probe.mjs',
      'require(`chalk`);\n',
      'app-tier',
    ],
  ])('rejects %s', (_name, path, text, rule) => {
    const { status, out } = run({ ...CLEAN, [path]: text });
    expect(out).toContain(`[${rule}]`);
    expect(status).toBe(1);
  });

  it.each([
    ['an import in a line comment', "// import { x } from 'vscode'\nexport const a = 1;\n"],
    ['a require in a block comment', "/* require('vscode') */\nexport const a = 1;\n"],
    ['a string that reads like an import', 'export const s = "x from \'vscode\'";\n'],
    [
      'a template string that reads like an import',
      "export const t = (a: string) => `import 'vscode' ${a}`;\n",
    ],
  ])('accepts %s in packages/foo', (_name, text) => {
    const { status, out } = run({ ...CLEAN, 'packages/foo/src/probe.ts': text });
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it('reports a multi-line import once, on the line its statement starts', () => {
    const { out } = run({
      ...CLEAN,
      'packages/foo/src/probe.ts':
        "export const a = 1;\nimport type {\n  Uri,\n}\n  from\n  'vscode';\n",
    });
    expect(out.match(/\[host-sdk\]/g)).toHaveLength(1);
    expect(out).toMatch(/probe\.ts:2 +\[host-sdk\]/);
  });

  it('reports two imports of one module on their own lines, once each', () => {
    const { out } = run({
      ...CLEAN,
      'packages/foo/src/probe.ts': "import 'vscode';\nexport * from 'vscode';\n",
    });
    expect(out.match(/\[host-sdk\]/g)).toHaveLength(2);
    expect(out).toMatch(/probe\.ts:1 +\[host-sdk\]/);
    expect(out).toMatch(/probe\.ts:2 +\[host-sdk\]/);
  });
});

// Owner decision 5 (2026-11-22, U2c.2): apps/cli loads at runtime only node builtins, @cpg/engine
// and @cpg/model; a statement-level type-only import of any other @cpg/* package is allowed. The
// CLI's tests are not its runtime and are exempt (like rule 8).
const cli = (path, text) => run({ ...CLEAN, [path]: text });

describe('rule 9: apps/cli loads only builtins, @cpg/engine and @cpg/model at runtime', () => {
  it.each([
    [
      'a value import of @cpg/sink',
      'apps/cli/src/main.ts',
      "import { createMemoryStore } from '@cpg/sink';\n",
      '@cpg/sink',
      1,
    ],
    [
      'a re-export from @cpg/store',
      'apps/cli/src/x.ts',
      "export const a = 1;\nexport { storeErrorCode } from '@cpg/store';\n",
      '@cpg/store',
      2,
    ],
    [
      'a require of @cpg/parse',
      'apps/cli/src/x.ts',
      "const p = require('@cpg/parse');\nexport default p;\n",
      '@cpg/parse',
      1,
    ],
    [
      'a dynamic import of @cpg/watch',
      'apps/cli/src/x.ts',
      "export const w = () => import('@cpg/watch');\n",
      '@cpg/watch',
      1,
    ],
    [
      'a side-effect import of @cpg/resolve',
      'apps/cli/src/x.ts',
      "import '@cpg/resolve';\n",
      '@cpg/resolve',
      1,
    ],
    [
      'the inline { type X } form, which keeps the import',
      'apps/cli/src/x.ts',
      "import { type GraphSink } from '@cpg/sink';\nexport type S = GraphSink;\n",
      '@cpg/sink',
      1,
    ],
    [
      'an import = require of @cpg/extract',
      'apps/cli/src/x.ts',
      "import x = require('@cpg/extract');\nexport { x };\n",
      '@cpg/extract',
      1,
    ],
    [
      'a nested .mjs file',
      'apps/cli/src/sub/deep/x.mjs',
      "import { createMemoryStore } from '@cpg/sink';\nexport { createMemoryStore };\n",
      '@cpg/sink',
      1,
    ],
  ])('rejects %s, naming the file, line and package', (_name, path, text, pkg, line) => {
    const { status, out } = cli(path, text);
    expect(status).toBe(1);
    expect(out).toMatch(
      new RegExp(`${path.replace(/[./]/g, '\\$&')}:${line} +\\[cli-runtime-import\\]`),
    );
    expect(out).toContain(`"${pkg}"`);
    expect(out.match(/\[cli-runtime-import\]/g)).toHaveLength(1);
  });

  it('accepts builtins, relative paths, @cpg/engine and @cpg/model at runtime', () => {
    const { status, out } = cli(
      'apps/cli/src/x.ts',
      [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        "import { createEngine } from '@cpg/engine';",
        "import { checkSchemaDoc } from '@cpg/model';",
        "import { run } from './run';",
        'export const all = [readFileSync, join, createEngine, checkSchemaDoc, run];',
        '',
      ].join('\n'),
    );
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it('accepts statement-level type-only imports and re-exports of any @cpg/* package', () => {
    const { status, out } = cli(
      'apps/cli/src/x.ts',
      [
        "import type { GraphSink } from '@cpg/sink';",
        "import type * as Store from '@cpg/store';",
        "export type { ParserBackend } from '@cpg/parse';",
        'export type S = GraphSink | Store.WriteOp;',
        '',
      ].join('\n'),
    );
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  // round two (review a7): a type-only import still has to pass rule 2 (app-tier)
  it.each([
    ['vscode', "import type { Uri } from 'vscode';\nexport type U = Uri;\n"],
    ['an npm package', "import type { Chalk } from 'chalk';\nexport type C = Chalk;\n"],
  ])('still rejects a type-only import of %s in apps/cli under app-tier', (_name, text) => {
    const { status, out } = cli('apps/cli/src/x.ts', text);
    expect(status).toBe(1);
    expect(out).toContain('[app-tier]');
    expect(out).not.toContain('[cli-runtime-import]');
  });

  it("exempts apps/cli's test files, which are not its runtime", () => {
    const { status, out } = cli(
      'apps/cli/src/x.test.ts',
      "import { createMemoryStore } from '@cpg/sink';\nexport const m = createMemoryStore;\n",
    );
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it('is scoped to apps/cli: another app may still load any @cpg/* front door', () => {
    const { status, out } = run({
      ...CLEAN,
      'apps/inspector/src/x.ts':
        "import { createMemoryStore } from '@cpg/sink';\nexport { createMemoryStore };\n",
      'apps/vscode/src/x.ts':
        "import { createMemoryStore } from '@cpg/sink';\nexport { createMemoryStore };\n",
    });
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });
});

// Owner decision 7a (2026-11-22): apps/inspector may import the archived renderer's library,
// @cosmos.gl/graph, and nothing else gets the exemption.
describe('check-deps: @cosmos.gl/graph is the inspector host SDK (owner decision 7a)', () => {
  it('lets apps/inspector import @cosmos.gl/graph at runtime and type-only, tests included', () => {
    const { status, out } = run({
      ...CLEAN,
      'apps/inspector/src/surface.ts':
        "import type { Graph } from '@cosmos.gl/graph' with { 'resolution-mode': 'import' };\nexport type S = Graph;\n",
      'apps/inspector/src/page.ts':
        "import { Graph } from '@cosmos.gl/graph';\nexport { Graph };\n",
      'apps/inspector/src/page.test.ts':
        "import { Graph } from '@cosmos.gl/graph';\nexport { Graph };\n",
    });
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it.each([
    ['one of its own dependencies in apps/inspector', 'apps/inspector/src/p.ts', 'd3-zoom'],
    [
      'another package of its scope in apps/inspector',
      'apps/inspector/src/p.ts',
      '@cosmos.gl/other',
    ],
    ['a name it only prefixes in apps/inspector', 'apps/inspector/src/p.ts', '@cosmos.gl/graphx'],
    ['@cosmos.gl/graph in apps/cli', 'apps/cli/src/p.ts', '@cosmos.gl/graph'],
    ['@cosmos.gl/graph in apps/vscode', 'apps/vscode/src/p.ts', '@cosmos.gl/graph'],
    ['@cosmos.gl/graph in apps/mcp', 'apps/mcp/src/p.ts', '@cosmos.gl/graph'],
  ])('still rejects %s', (_name, path, spec) => {
    const { status, out } = run({
      ...CLEAN,
      [path]: `import { x } from '${spec}';\nexport { x };\n`,
    });
    expect(out).toContain('[app-tier]');
    expect(out).toContain(`"${spec}"`);
    expect(status).toBe(1);
  });
});

// Owner decision 8a (2026-11-22): apps/inspector may import ws, for its WebSocket server, and no
// other app gets the exemption.
describe('check-deps: ws is the inspector WebSocket server (owner decision 8a)', () => {
  it('lets apps/inspector import ws at runtime and type-only, tests included', () => {
    const { status, out } = run({
      ...CLEAN,
      'apps/inspector/src/server.ts':
        "import { WebSocketServer } from 'ws';\nexport { WebSocketServer };\n",
      'apps/inspector/src/types.ts':
        "import type { WebSocket } from 'ws';\nexport type S = WebSocket;\n",
      'apps/inspector/src/server.test.ts':
        "import { WebSocket } from 'ws';\nexport { WebSocket };\n",
    });
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it.each([
    ['a name it only prefixes in apps/inspector', 'apps/inspector/src/p.ts', 'wss'],
    ['a scoped look-alike in apps/inspector', 'apps/inspector/src/p.ts', '@types/ws'],
    ['ws in apps/cli', 'apps/cli/src/p.ts', 'ws'],
    ['ws in apps/vscode', 'apps/vscode/src/p.ts', 'ws'],
    ['ws in apps/mcp', 'apps/mcp/src/p.ts', 'ws'],
  ])('still rejects %s', (_name, path, spec) => {
    const { status, out } = run({
      ...CLEAN,
      [path]: `import { x } from '${spec}';\nexport { x };\n`,
    });
    expect(out).toContain('[app-tier]');
    expect(out).toContain(`"${spec}"`);
    expect(status).toBe(1);
  });
});

// U3.1.1 part 4, controller decision 27: in apps/vscode/src, the three adapters and the composition root.
describe('rule 10: apps/vscode/src imports vscode in four files only', () => {
  const IMPORT = "import * as vscode from 'vscode';\nexport const v = vscode;\n";
  const FOUR = [
    'apps/vscode/src/extension.ts',
    'apps/vscode/src/adapters/webview-transport.ts',
    'apps/vscode/src/adapters/source-opener.ts',
    'apps/vscode/src/adapters/filesystem-probe.ts',
  ];

  it('accepts the four, type imports included, and leaves other directories to rule 2', () => {
    const four = Object.fromEntries(
      FOUR.map((path) => [
        path,
        `${IMPORT}import type { Uri } from 'vscode';\nexport type U = Uri;\n`,
      ]),
    );
    const { status, out } = run({
      ...CLEAN,
      ...four,
      'apps/vscode/src/theme.ts': "// import 'vscode' is a word here\nexport const t = 'vscode';\n",
      'apps/vscode/host-tests/open.ts': IMPORT,
    });
    expect(out).toContain('check-deps: ok');
    expect(status).toBe(0);
  });

  it.each([
    ['a value import', 'apps/vscode/src/graph-host.ts', IMPORT],
    [
      'a type import',
      'apps/vscode/src/x.ts',
      "import type { Uri } from 'vscode';\nexport type U = Uri;\n",
    ],
    ['an import type', 'apps/vscode/src/x.ts', "export type U = import('vscode').Uri;\n"],
    ['a re-export', 'apps/vscode/src/x.ts', "export * from 'vscode';\n"],
    ['a require', 'apps/vscode/src/x.ts', "export const v = require('vscode');\n"],
    ['a dynamic import', 'apps/vscode/src/x.ts', "export const v = import('vscode');\n"],
    ['a subpath', 'apps/vscode/src/x.ts', "import 'vscode/x';\n"],
    ['a test', 'apps/vscode/src/x.test.ts', IMPORT],
    ['another adapter', 'apps/vscode/src/adapters/other.ts', IMPORT],
    ['a same-named file elsewhere', 'apps/vscode/src/views/extension.ts', IMPORT],
    ['an adapter in a deeper directory', 'apps/vscode/src/x/adapters/source-opener.ts', IMPORT],
  ])('rejects %s', (_name, path, text) => {
    const { status, out } = run({ ...CLEAN, [path]: text });
    expect(out).toContain('[vscode-importer]');
    expect(out).toContain(`${path}:1`);
    expect(status).toBe(1);
  });
});
