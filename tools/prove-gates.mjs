#!/usr/bin/env node
// Proves every gate can fail. A gate nobody has seen fail is not a gate.
//
// Each case plants a violation, runs the gate command, and asserts a NON-ZERO
// exit. cleanup() always runs (finally), even when the plant or the gate throws.
// Every step that adds a gate must add its case to CASES below.
//
// Run: npm run check:gates

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const at = (p) => `${ROOT}/${p}`;

const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const sh = (cwd, cmd, args, opts = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', ...opts });
const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  return r;
};

// Leaves the index exactly as found: drops only the probe from it, then deletes the file.
function unstageProbe() {
  git([
    'rm',
    '--cached',
    '-f',
    '--quiet',
    '--ignore-unmatch',
    'packages/model/src/__gate_probe.ts',
  ]);
  rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
}

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
    // Realistic failure: a test-d file escapes the tsconfig exclusion and tsc emits it into dist.
    // Plants the dist files directly (what `tsc -b` would emit) and runs the tarball gate.
    name: 'check:pack rejects a test file and a runtime require in the model tarball',
    command: ['npm', 'run', '--silent', 'check:pack'],
    plant() {
      // dist is gitignored: a fresh checkout (CI) has none until a build runs.
      mkdirSync(at('packages/model/dist'), { recursive: true });
      writeFileSync(at('packages/model/dist/__gate_probe.test-d.js'), "require('vitest');\n");
    },
    cleanup() {
      rmSync(at('packages/model/dist/__gate_probe.test-d.js'), { force: true });
    },
  },
  {
    name: 'check:pack rejects a non-relative require in a non-test shipped .js',
    command: ['npm', 'run', '--silent', 'check:pack'],
    plant() {
      // dist is gitignored: a fresh checkout (CI) has none until a build runs.
      mkdirSync(at('packages/model/dist'), { recursive: true });
      writeFileSync(at('packages/model/dist/__gate_probe.js'), "require('left-pad');\n");
    },
    cleanup() {
      rmSync(at('packages/model/dist/__gate_probe.js'), { force: true });
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
    // Runtime-valid (the body never fails at runtime), so only the type check can reject it.
    name: 'typecheck:tests rejects a type error in a .test.ts',
    command: ['npm', 'run', '--silent', 'typecheck:tests'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.test.ts'),
        "import { expect, it } from 'vitest';\nit('probe', () => {\n  const n: number = 'oops';\n  expect(n).toBeDefined();\n});\n",
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.test.ts'), { force: true });
    },
  },
  {
    name: 'type test (*.test-d.ts) fails on a wrong type assertion',
    command: ['npm', 'run', '--silent', 'typecheck:tests'],
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
  {
    // The hook must reject, not just exist: stage a lint violation and run the real pre-commit job.
    name: 'lefthook pre-commit rejects a staged lint violation',
    command: ['npx', '--no-install', 'lefthook', 'run', 'pre-commit'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export function probe(): void {\n  debugger;\n}\n',
      );
      git(['add', 'packages/model/src/__gate_probe.ts']);
    },
    cleanup: unstageProbe,
  },
  {
    name: 'lefthook pre-push rejects a lint violation (runs the full npm run check)',
    command: ['npx', '--no-install', 'lefthook', 'run', 'pre-push'],
    // lefthook exits 0 with "(skip)" when it thinks there is nothing to push (up-to-date upstream,
    // detached CI checkout): that must never pass for a rejection.
    forbidOutput: /\(skip\)/,
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export function probe(): void {\n  debugger;\n}\n',
      );
    },
    cleanup() {
      unstageProbe();
      for (const ext of ['js', 'js.map', 'd.ts', 'd.ts.map'])
        rmSync(at(`packages/model/dist/__gate_probe.${ext}`), { force: true });
    },
  },
  {
    // Regression: lefthook skipped the pre-push job ("no matching push files") whenever HEAD had no
    // unpushed commits, so a push of nothing new, or any CI checkout, ran no gate. Build throwaway
    // clones where there is nothing to push and assert the hook still runs the full check and
    // rejects a planted lint violation. Uses the committed lefthook.yml (HEAD), not the worktree.
    name: 'lefthook pre-push never skips when there is nothing new to push (upstream up to date, detached HEAD + CI)',
    run() {
      const dir = mkdtempSync(`${tmpdir()}/cpg-prepush-`);
      try {
        const sha = must(git(['rev-parse', 'HEAD']), 'rev-parse').stdout.trim();
        const bare = `${dir}/origin.git`;
        const clone = `${dir}/clone`;
        must(sh(dir, 'git', ['init', '-q', '--bare', bare]), 'init bare');
        must(git(['push', '-q', bare, `${sha}:refs/heads/probe`]), 'push to throwaway origin');
        must(sh(dir, 'git', ['clone', '-q', '-b', 'probe', bare, clone]), 'clone');
        must(
          sh(clone, 'npm', [
            'ci',
            '--prefer-offline',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ]),
          'npm ci',
        );
        // Precondition: nothing to push, i.e. exactly the state that triggered the skip.
        const ahead = must(sh(clone, 'git', ['rev-list', '--count', '@{push}..HEAD']), 'ahead');
        if (ahead.stdout.trim() !== '0') throw new Error('clone is not up to date with upstream');
        writeFileSync(
          `${clone}/packages/model/src/__gate_probe.ts`,
          'export function probe(): void {\n  debugger;\n}\n',
        );
        // What git feeds the pre-push hook: <local ref> <local sha> <remote ref> <remote sha>.
        const stdin = `refs/heads/probe ${sha} refs/heads/probe ${sha}\n`;
        const push = (env) =>
          sh(clone, 'npx', ['--no-install', 'lefthook', 'run', 'pre-push', 'origin', bare], {
            input: stdin,
            env: { ...process.env, ...env },
          });
        const problems = [];
        const judge = (label, r) => {
          const out = `${r.stdout}${r.stderr}`;
          if (/\(skip\)/.test(out)) problems.push(`${label}: hook skipped`);
          else if (r.status === 0) problems.push(`${label}: exited 0 on a planted lint violation`);
        };
        judge('up-to-date upstream', push({}));
        must(sh(clone, 'git', ['checkout', '-q', '--detach']), 'detach');
        judge('detached HEAD, CI=true', push({ CI: 'true' }));
        if (problems.length) throw new Error(problems.join('; '));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    // Uncovered mutants count against the score, so an untested file must push it under `break`.
    name: 'test:mutation rejects an untested source file (break threshold)',
    command: ['npm', 'run', '--silent', 'test:mutation'],
    plant() {
      const body = Array.from(
        { length: 40 },
        (_, i) => `export function probe${i}(x: number): number {\n  return x + ${i};\n}\n`,
      ).join('\n');
      writeFileSync(at('packages/model/src/__gate_probe.ts'), body);
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
      // Drop incremental state so planted mutants cannot colour the next real run.
      rmSync(at('reports/stryker-incremental.json'), { force: true });
    },
  },
  {
    // Not part of `npm run check`, but it is the agent feedback loop: it must exit 2 on a lint error.
    name: 'claude post-edit hook exits exactly 2 on a lint violation',
    expectStatus: 2,
    command: [
      'sh',
      '-c',
      `echo '{"tool_input":{"file_path":"${at('packages/model/src/__gate_probe.ts')}"}}' | node tools/claude-post-edit.mjs`,
    ],
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
    // Counter-cases: the hook must not send false feedback on clean files (.json once did).
    name: 'claude post-edit hook exits 0 on a clean .ts file',
    expectStatus: 0,
    command: [
      'sh',
      '-c',
      `echo '{"tool_input":{"file_path":"${at('packages/model/src/__gate_probe.ts')}"}}' | node tools/claude-post-edit.mjs`,
    ],
    plant() {
      writeFileSync(at('packages/model/src/__gate_probe.ts'), 'export const probe = 1;\n');
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'claude post-edit hook exits 0 on a clean .json file',
    expectStatus: 0,
    command: [
      'sh',
      '-c',
      `echo '{"tool_input":{"file_path":"${at('packages/model/src/__gate_probe.json')}"}}' | node tools/claude-post-edit.mjs`,
    ],
    plant() {
      writeFileSync(at('packages/model/src/__gate_probe.json'), '{ "a": 1 }\n');
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.json'), { force: true });
    },
  },
];

const results = [];
for (const c of CASES) {
  let status;
  let detail = '';
  try {
    if (c.run) {
      c.run(); // self-contained case: throws on failure
      status = 'ok';
      results.push({ name: c.name, status, detail });
      continue;
    }
    c.plant();
    const r = spawnSync(c.command[0], c.command.slice(1), { cwd: ROOT, encoding: 'utf8' });
    if (r.error) {
      status = 'ERROR';
      detail = r.error.message;
    } else if (c.expectStatus !== undefined) {
      // Exact-status cases (e.g. the agent hook must exit 2, and 0 on clean files).
      if (r.status === c.expectStatus) status = 'ok';
      else {
        status = 'FAIL';
        detail = `expected exit ${c.expectStatus}, got ${r.status}`;
      }
    } else if (c.forbidOutput?.test(`${r.stdout}${r.stderr}`)) {
      status = 'FAIL';
      detail = `output matched ${c.forbidOutput} (gate was skipped, not run)`;
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
      c.cleanup?.();
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
