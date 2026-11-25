#!/usr/bin/env node
// REAL (U3.1.1 part 1, BMO-18, controller decision 26): U3's machine gate.
//
// Usage: node tools/check-unit-diff.mjs [root]
//
// On any feat/u3.* pull request, the net diff under packages/ since the merge base with
// origin/<GITHUB_BASE_REF> must be empty (BMO-18): U3 lands extension/host work without modifying
// core packages. Non-PR runs (GITHUB_HEAD_REF unset or empty) and PRs from other branches pass
// because the rule does not apply. A feat/u3.* PR that cannot be compared against its base fails
// loudly rather than passing silently.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(fileURLToPath(new URL('..', import.meta.url)));

const head = process.env.GITHUB_HEAD_REF;
if (!head) {
  console.log(
    'check-unit-diff: the rule does not apply (GITHUB_HEAD_REF is not set; only a feat/u3.* pull request is judged)',
  );
  process.exit(0);
}

if (!head.startsWith('feat/u3.')) {
  console.log(
    `check-unit-diff: the rule does not apply to ${head} (only a feat/u3.* pull request is judged)`,
  );
  process.exit(0);
}

const base = process.env.GITHUB_BASE_REF;
if (!base) {
  console.error(
    `check-unit-diff: GITHUB_BASE_REF is not set; cannot judge ${head} without its base branch`,
  );
  process.exit(1);
}

const baseRef = `origin/${base}`;

/** One git command's stdout. An argument array, never a shell: the refs are a PR author's text. */
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    // merge-base exits 1 and says nothing when the two share no history.
    const detail = r.stderr?.trim() || r.error?.message || 'no common commit';
    console.error(`check-unit-diff: cannot compare with ${baseRef}: ${detail}`);
    process.exit(1);
  }
  return r.stdout;
}

const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
// --no-renames and -z: every offending path, whatever the git config, spelled as it is on disk.
const range = [mergeBase, 'HEAD', '--', 'packages/'];
const changed = git(['diff', '--name-only', '--no-renames', '-z', ...range])
  .split('\0')
  .filter(Boolean);
if (changed.length > 0) {
  console.error(`check-unit-diff: ${head} changes packages/, which U3's gate forbids (BMO-18):`);
  for (const path of changed) console.error(`  ${path}`);
  process.exit(1);
}

console.log(
  `check-unit-diff: ok: ${head} changes nothing under packages/ since ${baseRef} (${mergeBase.slice(0, 7)})`,
);
