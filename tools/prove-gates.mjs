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
    name: 'format:check rejects a mis-formatted .ts file',
    command: ['npm', 'run', '--silent', 'format:check'],
    plant() {
      // Double quotes, no semicolon, extra spaces: violates every non-default format choice.
      writeFileSync(at('packages/model/src/__gate_probe.ts'), 'export const   probe = "x"\n');
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'lint rejects a floating promise (type-aware rule)',
    command: ['npm', 'run', '--silent', 'lint'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'async function work(): Promise<void> {}\nexport function probe(): void {\n  work();\n}\n',
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'lint rejects a debugger statement (correctness)',
    command: ['npm', 'run', '--silent', 'lint'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export function probe(): void {\n  debugger;\n}\n',
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'knip rejects an unreferenced file with an unused export',
    command: ['npm', 'run', '--silent', 'knip'],
    plant() {
      writeFileSync(at('packages/model/src/__gate_probe.ts'), 'export const probe = 1;\n');
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
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
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export const probe: number = "not a number";\n',
      );
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
  {
    name: 'npm test fails on a failing test (and a glob matching nothing is not a pass)',
    command: ['npm', 'run', '--silent', 'test'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.test.ts'),
        "import { expect, it } from 'vitest';\nit('probe', () => {\n  expect(1).toBe(2);\n});\n",
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.test.ts'), { force: true });
    },
  },
  {
    name: 'vitest with an include glob matching no files exits non-zero (passWithNoTests: false)',
    command: ['npx', 'vitest', 'run', '--typecheck.enabled=false', 'no-such-dir-probe'],
    plant() {},
    cleanup() {},
  },
  {
    name: 'test:coverage rejects an untested source file (threshold)',
    command: ['npm', 'run', '--silent', 'test:coverage'],
    plant() {
      const body = Array.from(
        { length: 40 },
        (_, i) => `export function probe${i}(x: number): number {\n  return x + ${i};\n}\n`,
      ).join('\n');
      writeFileSync(at('packages/model/src/__gate_probe.ts'), body);
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'type test (*.test-d.ts) fails on a wrong type assertion',
    command: ['npm', 'run', '--silent', 'test'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.test-d.ts'),
        "import { expectTypeOf, it } from 'vitest';\nit('probe', () => {\n  expectTypeOf<string>().toEqualTypeOf<number>();\n});\n",
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.test-d.ts'), { force: true });
    },
  },
  {
    // Turbo must never mask a failure via its cache: warm the cache on the clean tree, plant a
    // lint violation, and run the FULL `npm run check` twice (a failed run must not be cached
    // either). The asserted run is the second one; the first only has to have been attempted.
    name: 'npm run check fails on a planted lint error even with a warm turbo cache',
    command: ['npm', 'run', '--silent', 'check'],
    plant() {
      const warm = spawnSync('npm', ['run', '--silent', 'check'], { cwd: ROOT, encoding: 'utf8' });
      if (warm.status !== 0) throw new Error('baseline `npm run check` must pass before this case');
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export function probe(): void {\n  debugger;\n}\n',
      );
      spawnSync('npm', ['run', '--silent', 'check'], { cwd: ROOT, encoding: 'utf8' });
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
      // tsc -b emits the probe into dist when only lint is violated.
      for (const ext of ['js', 'js.map', 'd.ts', 'd.ts.map'])
        rmSync(at(`packages/model/dist/__gate_probe.${ext}`), { force: true });
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
      detail += ` cleanup failed: ${String(e)}`;
    }
  }
  results.push({ name: c.name, status, detail });
}

for (const r of results)
  console.log(`${r.status.padEnd(5)} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const bad = results.filter((r) => r.status !== 'ok');
console.log(
  bad.length
    ? `\n${bad.length} gate(s) did not fail when they should have`
    : '\nall gates fail when violated',
);
process.exit(bad.length ? 1 : 0);
