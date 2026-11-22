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
    // documented false positive: a quoted specifier inside a comment is flagged; pinned so nobody "fixes" it silently
    [
      'a quoted specifier inside a comment',
      "// see import { x } from '@cpg/model'\nexport type R = 1;\n",
    ],
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
