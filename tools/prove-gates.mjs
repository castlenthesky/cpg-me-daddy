#!/usr/bin/env node
// Proves every gate can fail. A gate nobody has seen fail is not a gate.
//
// Each case plants a violation, runs the gate command, and asserts a NON-ZERO
// exit AND that the output names the violation (`expectOutput`: string or RegExp, normally the
// planted file or the rule id). The second half matters: a crashed script, a typo'd package script or a
// missing binary also exits non-zero, and must not be mistaken for the gate rejecting the probe.
// A case without `expectOutput` is allowed only when impossible, and is listed in a warning.
// cleanup() always runs (finally), even when the plant or the gate throws.
// Every step that adds a gate must add its case to CASES below.
//
// Slow cases carry `slow: true`. PROVE_GATES_SKIP_SLOW=1 skips them (and logs which, never
// silently); `--only-slow` runs only them. Default (no flag, no env): everything runs.
//
// Run: bun run check:gates [-- --only-slow]

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

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

// Colour codes would break the output matchers.
const PLAIN_ENV = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
const outputOf = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
const matches = (pattern, text) =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
const tail = (text) => text.trim().split('\n').slice(-6).join(' | ').slice(0, 400);

// Judges one gate run against a case's expectations; returns a problem string, or null when the
// gate rejected the violation the way the case says it should.
function verdict(r, c) {
  const out = outputOf(r);
  if (r.error) return `could not run: ${r.error.message}`;
  if (r.status === null) return `killed by signal ${r.signal}`;
  if (c.forbidOutput?.test(out))
    return `output matched ${c.forbidOutput} (gate was skipped, not run)`;
  if (c.expectStatus !== undefined) {
    // Exact-status cases (e.g. the agent hook must exit 2, and 0 on clean files).
    if (r.status !== c.expectStatus) return `expected exit ${c.expectStatus}, got ${r.status}`;
  } else if (r.status === 0) return 'gate exited 0 on a planted violation';
  if (c.expectOutput !== undefined && !matches(c.expectOutput, out))
    return `exit ${r.status} but output does not mention ${c.expectOutput} (crash, not a rejection?): ${tail(out)}`;
  return null;
}

// Removes every probe a case may have planted, plus what `tsc -b` emits from them.
function cleanupProbes() {
  for (const dir of ['packages/model/src', 'packages/model/dist']) {
    if (!existsSync(at(dir))) continue;
    for (const f of readdirSync(at(dir)))
      if (f.startsWith('__gate_probe')) rmSync(at(`${dir}/${f}`), { force: true });
  }
}

// A planted file in one of the trees check-deps scans. An app that does not exist yet (apps/cli)
// is created for the plant and removed with it.
const depsCase = (name, file, body, expectOutput) => {
  let made;
  return {
    name,
    command: ['bun', 'run', '--silent', 'check:deps'],
    expectOutput,
    plant() {
      made = mkdirSync(at(dirname(file)), { recursive: true });
      writeFileSync(at(file), body);
    },
    cleanup() {
      rmSync(at(file), { force: true });
      if (made) rmSync(made, { recursive: true, force: true });
    },
  };
};

const runCheck = () =>
  spawnSync('bun', ['run', '--silent', 'check'], { cwd: ROOT, encoding: 'utf8', env: PLAIN_ENV });

// Config-driven cache invalidation. Turbo must never replay a cached pass after a CONFIG-only
// edit: warm the cache on a tree that is legal under the current config, change ONLY the config so
// the tree becomes a violation, then run the full check and require (1) a failure that names the
// violation and (2) that turbo reported a cache MISS for the task, i.e. the config is a task input.
// `plant` writes files that are legal under every gate and the unedited config; the config text is
// always restored in finally.
function configCase({ name, task, file, from, to, expectOutput, plant }) {
  return {
    name,
    expectOutput,
    run() {
      const path = at(file);
      const original = readFileSync(path, 'utf8');
      if (!original.includes(from)) throw new Error(`${file} no longer contains: ${from}`);
      try {
        plant?.();
        const warm = runCheck();
        if (warm.status !== 0)
          throw new Error(`baseline \`bun run check\` must pass first: ${tail(outputOf(warm))}`);
        writeFileSync(
          path,
          original.replace(from, () => to),
        );
        const r = runCheck();
        const problem = verdict(r, { expectOutput });
        if (problem) throw new Error(problem);
        if (!new RegExp(`^//:${task}: cache miss`, 'm').test(outputOf(r)))
          throw new Error(
            `${task} was not a cache miss after editing ${file}: add it to turbo.json inputs`,
          );
      } finally {
        writeFileSync(path, original);
        cleanupProbes();
      }
    },
  };
}

// Legal under every gate (knip treats *.test.ts as a vitest entry; coverage ignores it).
const probeTest = (body) => () =>
  writeFileSync(
    at('packages/model/src/__gate_probe.test.ts'),
    `import { expect, it } from 'vitest';\n\nit('gate probe', () => {\n${body}\n  expect(1).toBe(1);\n});\n`,
  );

const CASES = [
  {
    // oxlint is the single owner of unused-variable checks (tsc's noUnused* flags are off).
    name: 'lint rejects an unused local variable (no-unused-vars)',
    expectOutput: /no-unused-vars/,
    command: ['bun', 'run', '--silent', 'lint'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export function probe(): number {\n  const unused = 1;\n  return 2;\n}\n',
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    // `before` is unused but sits BEFORE a used parameter: needs args "all" (default is after-used).
    name: 'lint rejects an unused function parameter (no-unused-vars, args: all)',
    expectOutput: /no-unused-vars/,
    command: ['bun', 'run', '--silent', 'lint'],
    plant() {
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export function probe(before: number, after: number): number {\n  return after;\n}\n',
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'format:check rejects a mis-formatted .ts file',
    expectOutput: /__gate_probe\.ts/,
    command: ['bun', 'run', '--silent', 'format:check'],
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
    expectOutput: /no-floating-promises/,
    command: ['bun', 'run', '--silent', 'lint'],
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
    expectOutput: /no-debugger/,
    command: ['bun', 'run', '--silent', 'lint'],
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
    expectOutput: /__gate_probe\.ts/,
    command: ['bun', 'run', '--silent', 'knip'],
    plant() {
      writeFileSync(at('packages/model/src/__gate_probe.ts'), 'export const probe = 1;\n');
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
    },
  },
  {
    name: 'check:coords rejects an archive coordinate that does not resolve',
    expectOutput: /__gate_probe\.md:1 +27361a3:packages\/engine\/src\/schema\/nope\.ts/,
    command: ['bun', 'run', '--silent', 'check:coords'],
    plant() {
      writeFileSync(
        at('docs/outline/__gate_probe.md'),
        'Port `27361a3:packages/engine/src/schema/nope.ts`.\n',
      );
    },
    cleanup() {
      rmSync(at('docs/outline/__gate_probe.md'), { force: true });
    },
  },
  // check:deps on the real tree: the three tier violations U0.2.2 names, one per rule. Every other
  // rule and specifier form is planted on fixtures in tools/check-deps.test.mjs; the case after
  // these proves `bun run test` runs that file.
  depsCase(
    'check:deps rejects a vscode import in packages/model (host-sdk)',
    'packages/model/src/__gate_probe.ts',
    "import * as vscode from 'vscode';\nexport const probe = vscode;\n",
    /__gate_probe\.ts:1 +\[host-sdk\]/,
  ),
  depsCase(
    'check:deps rejects the MCP SDK in apps/vscode (app-tier)',
    'apps/vscode/src/__gate_probe.ts',
    "import { Server } from '@modelcontextprotocol/sdk';\nexport const probe = Server;\n",
    /__gate_probe\.ts:1 +\[app-tier\]/,
  ),
  depsCase(
    'check:deps rejects a deep import of @cpg/model in apps/cli (deep-import)',
    'apps/cli/src/__gate_probe.ts',
    "export { x } from '@cpg/model/dist/x';\n",
    /__gate_probe\.ts:1 +\[deep-import\]/,
  ),
  {
    // The check-deps rules are proven by fixtures in tools/check-deps.test.mjs. If the vitest
    // include stopped matching tools/, that proof would vanish while `bun run test` stayed green.
    name: 'bun run test runs tools/*.test.mjs (the check-deps rule fixtures run under the check)',
    expectOutput: /__gate_probe\.test\.mjs/,
    command: ['bun', 'run', '--silent', 'test'],
    plant() {
      writeFileSync(
        at('tools/__gate_probe.test.mjs'),
        "import { expect, it } from 'vitest';\nit('probe', () => {\n  expect(1).toBe(2);\n});\n",
      );
    },
    cleanup() {
      rmSync(at('tools/__gate_probe.test.mjs'), { force: true });
    },
  },
  {
    // Realistic failure: a test-d file escapes the tsconfig exclusion and tsc emits it into dist.
    // Plants the dist files directly (what `tsc -b` would emit) and runs the tarball gate.
    name: 'check:pack rejects a test file and a runtime require in the model tarball',
    expectOutput: /__gate_probe\.test-d\.js/,
    command: ['bun', 'run', '--silent', 'check:pack'],
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
    expectOutput: /__gate_probe\.js/,
    command: ['bun', 'run', '--silent', 'check:pack'],
    plant() {
      // dist is gitignored: a fresh checkout (CI) has none until a build runs.
      mkdirSync(at('packages/model/dist'), { recursive: true });
      writeFileSync(at('packages/model/dist/__gate_probe.js'), "require('left-pad');\n");
    },
    cleanup() {
      rmSync(at('packages/model/dist/__gate_probe.js'), { force: true });
    },
  },
  (() => {
    // Realistic failure: main.ts stops assigning process.exitCode, so every error exits 0. Only
    // spawning the BUILT bin can see that; the in-process run() tests stay green.
    const file = at('apps/cli/src/main.ts');
    const from = 'process.exitCode = code;';
    let original = '';
    return {
      name: 'check:cli-bin rejects a built bin that exits 0 on an unknown verb',
      expectOutput: /cpg frobnicate: expected exit 2/,
      command: ['bun', 'run', '--silent', 'check:cli-bin'],
      plant() {
        original = readFileSync(file, 'utf8');
        if (!original.includes(from)) throw new Error(`main.ts no longer contains: ${from}`);
        writeFileSync(file, original.replace(from, 'void code;'));
      },
      cleanup() {
        if (original) writeFileSync(file, original);
        // Rebuild so the probe's dist/main.js never outlives the probe.
        must(sh(ROOT, 'bun', ['run', '--silent', 'tsc', '-b', 'apps/cli']), 'rebuild apps/cli');
      },
    };
  })(),
  {
    name: 'typecheck rejects a type error',
    expectOutput: /TS2322/,
    command: ['bun', 'run', '--silent', 'typecheck'],
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
    name: 'bun run test fails on a failing test (and a glob matching nothing is not a pass)',
    expectOutput: /__gate_probe\.test\.ts/,
    command: ['bun', 'run', '--silent', 'test'],
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
    expectOutput: /No test files found/i,
    command: ['bun', 'run', 'vitest', 'run', '--typecheck.enabled=false', 'no-such-dir-probe'],
    plant() {},
    cleanup() {},
  },
  {
    name: 'test:coverage rejects an untested source file (threshold)',
    expectOutput: /does not meet global threshold/,
    command: ['bun', 'run', '--silent', 'test:coverage'],
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
    expectOutput: /__gate_probe\.test\.ts.*TS2322/,
    command: ['bun', 'run', '--silent', 'typecheck:tests'],
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
    expectOutput: /__gate_probe\.test-d\.ts/,
    command: ['bun', 'run', '--silent', 'typecheck:tests'],
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
    // lint violation, and run the FULL `bun run check` twice (a failed run must not be cached
    // either). The asserted run is the second one; the first only has to have been attempted.
    name: 'bun run check fails on a planted lint error even with a warm turbo cache',
    expectOutput: /no-debugger/,
    command: ['bun', 'run', '--silent', 'check'],
    plant() {
      const warm = spawnSync('bun', ['run', '--silent', 'check'], { cwd: ROOT, encoding: 'utf8' });
      if (warm.status !== 0) throw new Error('baseline `bun run check` must pass before this case');
      writeFileSync(
        at('packages/model/src/__gate_probe.ts'),
        'export function probe(): void {\n  debugger;\n}\n',
      );
      spawnSync('bun', ['run', '--silent', 'check'], { cwd: ROOT, encoding: 'utf8' });
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
    expectOutput: /no-debugger/,
    command: ['bun', 'run', 'lefthook', 'run', 'pre-commit'],
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
    name: 'lefthook pre-push rejects a lint violation (runs the full bun run check)',
    expectOutput: /no-debugger/,
    command: ['bun', 'run', 'lefthook', 'run', 'pre-push'],
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
    // rejects a planted lint violation. The clone is HEAD plus the worktree's bun hook,
    // lockfile, and check runner, so the job under test is the one this tree ships.
    name: 'lefthook pre-push never skips when there is nothing new to push (upstream up to date, detached HEAD + CI)',
    expectOutput: 'no-debugger', // asserted per run inside run()
    run() {
      const dir = mkdtempSync(`${tmpdir()}/cpg-prepush-`);
      try {
        const sha = must(git(['rev-parse', 'HEAD']), 'rev-parse').stdout.trim();
        const bare = `${dir}/origin.git`;
        const clone = `${dir}/clone`;
        must(sh(dir, 'git', ['init', '-q', '--bare', bare]), 'init bare');
        must(git(['push', '-q', bare, `${sha}:refs/heads/probe`]), 'push to throwaway origin');
        must(sh(dir, 'git', ['clone', '-q', '-b', 'probe', bare, clone]), 'clone');
        // The clone is HEAD. Overlay the worktree hook, lockfile, and check runner so the
        // installed tree matches the bun commands this file tests, then install from bun.lock.
        for (const rel of ['lefthook.yml', 'package.json', 'bun.lock', 'tools/check.mjs'])
          copyFileSync(at(rel), `${clone}/${rel}`);
        must(sh(clone, 'bun', ['install', '--frozen-lockfile']), 'bun install --frozen-lockfile');
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
          sh(clone, 'bun', ['run', 'lefthook', 'run', 'pre-push', 'origin', bare], {
            input: stdin,
            env: { ...process.env, ...env },
          });
        const problems = [];
        const judge = (label, r) => {
          const out = `${r.stdout}${r.stderr}`;
          if (/\(skip\)/.test(out)) problems.push(`${label}: hook skipped`);
          else if (r.status === 0) problems.push(`${label}: exited 0 on a planted lint violation`);
          else if (!/no-debugger/.test(out))
            problems.push(`${label}: failed without naming no-debugger`);
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
    // Only the probe is mutated, so the score is the probe's own (0) however much tested code
    // exists: a fixed-size probe in the full mutate set stopped crossing `break` once U1's
    // validator tests landed. The planted test imports the probe and calls nothing; without it,
    // vitest finds no test related to the probe and Stryker aborts before scoring.
    slow: true,
    name: 'test:mutation rejects an untested source file (break threshold)',
    expectOutput: /threshold|break/i,
    command: [
      'bun',
      'run',
      '--silent',
      'test:mutation',
      '--mutate',
      'packages/model/src/__gate_probe.ts',
    ],
    plant() {
      const body = Array.from(
        { length: 40 },
        (_, i) => `export function probe${i}(x: number): number {\n  return x + ${i};\n}\n`,
      ).join('\n');
      writeFileSync(at('packages/model/src/__gate_probe.ts'), body);
      writeFileSync(
        at('packages/model/src/__gate_probe.test.ts'),
        "import { expect, test } from 'vitest';\nimport * as probe from './__gate_probe';\n\n" +
          "test('loads the probe', () => {\n  expect(probe).toBeDefined();\n});\n",
      );
    },
    cleanup() {
      rmSync(at('packages/model/src/__gate_probe.ts'), { force: true });
      rmSync(at('packages/model/src/__gate_probe.test.ts'), { force: true });
      // Drop incremental state so planted mutants cannot colour the next real run.
      rmSync(at('reports/stryker-incremental.json'), { force: true });
    },
  },
  {
    // Not part of `bun run check`, but it is the agent feedback loop: it must exit 2 on a lint error.
    name: 'claude post-edit hook exits exactly 2 on a lint violation',
    expectOutput: /no-debugger/,
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
  configCase({
    name: 'lint: a .oxlintrc.json-only edit (no-console to error) invalidates the turbo cache',
    task: 'lint',
    file: '.oxlintrc.json',
    from: '"rules": {',
    to: '"rules": {\n    "no-console": "error",',
    expectOutput: /no-console/,
    plant: probeTest("  console.log('probe');"),
  }),
  configCase({
    name: 'test: a vitest.config.mts-only edit (coverage threshold 100) invalidates the turbo cache',
    task: 'test:coverage',
    file: 'vitest.config.mts',
    from: 'lines: 95,',
    to: 'lines: 100,',
    expectOutput: /does not meet global threshold \(100%\)/,
  }),
  configCase({
    name: 'typecheck: a tsconfig.base.json-only edit (noPropertyAccessFromIndexSignature) invalidates the turbo cache',
    task: 'typecheck:tests',
    file: 'tsconfig.base.json',
    from: '"noFallthroughCasesInSwitch": true',
    to: '"noFallthroughCasesInSwitch": true,\n    "noPropertyAccessFromIndexSignature": true',
    expectOutput: /TS4111/,
    plant: probeTest('  const o: Record<string, number> = {};\n  expect(o.x).toBeUndefined();'),
  }),
  configCase({
    name: 'format: an .oxfmtrc.json-only edit (singleQuote off) invalidates the turbo cache',
    task: 'format:check',
    file: '.oxfmtrc.json',
    from: '"singleQuote": true,',
    to: '"singleQuote": false,',
    expectOutput: /apps\/vscode\/src\/extension\.ts/,
  }),
  configCase({
    name: 'knip: a knip.json-only edit (drop the tools entry) invalidates the turbo cache',
    task: 'knip',
    file: 'knip.json',
    from: '"entry": ["tools/*.mjs"],',
    to: '"entry": [],',
    expectOutput: /claude-post-edit\.mjs/,
  }),
];

const onlySlow = process.argv.includes('--only-slow');
const skipSlow = process.env.PROVE_GATES_SKIP_SLOW === '1' && !onlySlow;
const selected = CASES.filter((c) => (onlySlow ? c.slow : !(skipSlow && c.slow)));
const skipped = CASES.filter((c) => !selected.includes(c));
if (skipped.length)
  console.log(
    `SKIPPED ${skipped.length} case(s) (${onlySlow ? 'not slow, --only-slow' : 'slow, PROVE_GATES_SKIP_SLOW=1'}):\n` +
      skipped.map((c) => `  - ${c.name}`).join('\n') +
      '\n',
  );

const results = [];
for (const c of selected) {
  let status;
  let detail = '';
  try {
    if (c.run) {
      c.run(); // self-contained case: throws on failure
      status = 'ok';
    } else {
      c.plant();
      const r = spawnSync(c.command[0], c.command.slice(1), {
        cwd: ROOT,
        encoding: 'utf8',
        env: PLAIN_ENV,
      });
      const problem = verdict(r, c);
      status = problem ? 'FAIL' : 'ok';
      detail = problem ?? '';
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

const unchecked = selected.filter((c) => c.expectOutput === undefined);
if (unchecked.length)
  console.warn(
    `\nWARNING: ${unchecked.length} case(s) have no expectOutput, so a crash would pass for a rejection:\n` +
      unchecked.map((c) => `  - ${c.name}`).join('\n'),
  );

const bad = results.filter((r) => r.status !== 'ok');
console.log(
  bad.length
    ? `\n${bad.length} gate(s) did not fail when they should have`
    : '\nall gates fail when violated',
);
process.exit(bad.length ? 1 : 0);
