#!/usr/bin/env node
// Proves every gate can fail. A gate nobody has seen fail is not a gate.
//
// Each case plants a violation, runs the gate command, and asserts a NON-ZERO
// exit. cleanup() always runs (finally), even when the plant or the gate throws.
// Every step that adds a gate must add its case to CASES below.
//
// Run: npm run check:gates

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const at = (p) => `${ROOT}/${p}`;

const CASES = [
  {
    name: 'check:deps rejects a vscode import in packages/**',
    command: ['npm', 'run', '--silent', 'check:deps'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        "import * as vscode from 'vscode';\nexport const probe = vscode;\n",
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'typecheck rejects a type error',
    command: ['npm', 'run', '--silent', 'typecheck'],
    plant() {
      writeFileSync(at('packages/model/src/__gate_probe.ts'), 'export const probe: number = "not a number";\n');
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
      // Drop incremental state so a failed planted build cannot leave stale output.
      rmSync(at('packages/model/dist/__gate_probe.js'), { force: true });
      rmSync(at('packages/model/dist/__gate_probe.d.ts'), { force: true });
      rmSync(at('packages/model/dist/__gate_probe.d.ts.map'), { force: true });
      rmSync(at('packages/model/dist/__gate_probe.js.map'), { force: true });
    },
  },
];

const results = [];
for (const c of CASES) {
  let status;
  let detail = '';
  try {
    c.plant();
    const r = spawnSync(c.command[0], c.command.slice(1), { cwd: ROOT, encoding: 'utf8' });
    if (r.error) {
      status = 'ERROR';
      detail = r.error.message;
    } else if (r.status === 0) {
      status = 'FAIL';
      detail = 'gate exited 0 on a planted violation';
    } else {
      status = 'ok';
    }
  } catch (e) {
    status = 'ERROR';
    detail = String(e);
  } finally {
    try {
      c.cleanup();
    } catch (e) {
      status = 'ERROR';
      detail += ` cleanup failed: ${e}`;
    }
  }
  results.push({ name: c.name, status, detail });
}

for (const r of results) console.log(`${r.status.padEnd(5)} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const bad = results.filter((r) => r.status !== 'ok');
console.log(bad.length ? `\n${bad.length} gate(s) did not fail when they should have` : '\nall gates fail when violated');
process.exit(bad.length ? 1 : 0);
