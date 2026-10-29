// A rule nobody has seen fail is not a gate (L-31). Each case builds a throwaway
// repository, plants exactly one violation, and asserts check-deps rejects it
// with the right rule. The clean cases prove the gate is not vacuously red.

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
  'apps/vscode/src/extension.ts': "import * as vscode from 'vscode';\nimport { x } from '@cpg/model';\nimport { join } from 'node:path';\n",
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

  it('lets packages/engine know more than one sibling', () => {
    const { status } = run({ ...CLEAN, 'packages/engine/src/index.ts': "import '@cpg/watch';\nimport '@cpg/parse';\n" });
    expect(status).toBe(0);
  });
});

describe('check-deps rejects every planted violation', () => {
  const cases = [
    ['vscode in packages/model', 'packages/model/src/probe.ts', "import * as vscode from 'vscode';\n", 'host-sdk'],
    ['side-effect vscode import in packages/foo', 'packages/foo/src/probe.ts', "import 'vscode';\n", 'host-sdk'],
    ['the MCP SDK in packages/foo', 'packages/foo/src/probe.ts', "import { Server } from '@modelcontextprotocol/sdk/server';\n", 'host-sdk'],
    ['a DOM global in packages/foo', 'packages/foo/src/probe.ts', 'export const w = document.body;\n', 'host-sdk'],
    ['a vscode require in stale packages/foo/dist', 'packages/foo/dist/probe.js', 'const v = require("vscode");\n', 'host-sdk'],
    ['@modelcontextprotocol in apps/vscode', 'apps/vscode/src/probe.ts', "import { Server } from '@modelcontextprotocol/sdk';\n", 'app-tier'],
    ['vscode in apps/cli', 'apps/cli/src/probe.ts', "import 'vscode';\n", 'app-tier'],
    ['an arbitrary npm package in apps/cli', 'apps/cli/src/probe.ts', "import chalk from 'chalk';\n", 'app-tier'],
    ['a deep import in apps/vscode', 'apps/vscode/src/probe.ts', "import { x } from '@cpg/model/dist/x';\n", 'deep-import'],
    ['a deep import in apps/cli', 'apps/cli/src/probe.ts', "import { x } from '@cpg/model/dist/x';\n", 'deep-import'],
    ['a runtime dep in @cpg/model', 'packages/model/src/probe.ts', "import yaml from 'yaml';\n", 'model-zero-deps'],
    ['a composition root in packages/foo', 'packages/foo/src/probe.ts', "import '@cpg/watch';\nimport '@cpg/parse';\n", 'composition-root'],
    ['a NUL byte', 'packages/foo/src/probe.ts', `export const s = 1;${String.fromCharCode(0)}\n`, 'nul-byte'],
  ];

  it.each(cases)('%s', (_name, path, text, rule) => {
    const { status, out } = run({ ...CLEAN, [path]: text });
    expect(status).toBe(1);
    expect(out).toContain(`[${rule}]`);
  });
});
