// U3's machine gate (BMO-18; controller decision 26): on a feat/u3.* pull request the diff under
// packages/** is empty. Every case runs the script against a throwaway git repository. Git runs with
// a clean environment, because a git hook sets GIT_DIR and friends, which would aim these commands at
// this repository.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'tools', 'check-unit-diff.mjs');
const HEAD = 'feat/u3.1.1-graph-host';
const BASE = 'fix/u3-prep-engine';
const roots = [];

const CLEAN_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: CLEAN_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function commit(root, files = {}) {
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'c');
  return git(root, 'rev-parse', 'HEAD');
}

/** Points origin/<BASE> at `sha`, as actions/checkout's full fetch leaves it. */
const setBase = (root, sha) => git(root, 'update-ref', `refs/remotes/origin/${BASE}`, sha);

/** A repository whose HEAD is the base commit, on branch `work`. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'check-unit-diff-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'work');
  const base = commit(root, {
    'packages/model/src/a.ts': 'export const a = 1;\n',
    'packages/model/src/b.ts': 'export const b = 1;\n',
    'apps/vscode/src/x.ts': 'export const x = 1;\n',
  });
  setBase(root, base);
  return { root, base };
}

function run(root, refs = { GITHUB_HEAD_REF: HEAD, GITHUB_BASE_REF: BASE }) {
  const r = spawnSync(process.execPath, [SCRIPT, root], {
    cwd: root,
    encoding: 'utf8',
    env: { ...CLEAN_ENV, ...refs },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The paths a violation lists: the two-space-indented lines. */
const listed = (out) =>
  out
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.slice(2));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a feat/u3.* pull request', () => {
  it('passes when nothing under packages/ changed, naming the branch', () => {
    const { root } = repo();
    commit(root, {
      'apps/vscode/src/x.ts': 'export const x = 2;\n',
      'apps/packages/y.ts': 'export const y = 1;\n',
      'packages-extra/z.ts': 'export const z = 1;\n',
      'tools/packages': 'not the directory\n',
    });
    const { status, out } = run(root);
    expect(out).toContain(`check-unit-diff: ok: ${HEAD} changes nothing under packages/`);
    expect(status).toBe(0);
  });

  it('lists every changed, added and deleted path under packages/ and exits 1', () => {
    const { root } = repo();
    rmSync(join(root, 'packages/model/src/b.ts'));
    commit(root, {
      'packages/model/src/a.ts': 'export const a = 2;\n',
      'packages/engine/new "file".ts': 'export const n = 1;\n',
      'apps/vscode/src/x.ts': 'export const x = 2;\n',
    });
    const { status, out } = run(root);
    expect(out).toContain(`check-unit-diff: ${HEAD} changes packages/`);
    expect(listed(out)).toEqual([
      'packages/engine/new "file".ts',
      'packages/model/src/a.ts',
      'packages/model/src/b.ts',
    ]);
    expect(status).toBe(1);
  });

  it('flags a file moved out of packages/', () => {
    const { root } = repo();
    renameSync(join(root, 'packages/model/src/a.ts'), join(root, 'apps/vscode/src/a.ts'));
    commit(root);
    const { status, out } = run(root);
    expect(listed(out)).toEqual(['packages/model/src/a.ts']);
    expect(status).toBe(1);
  });

  it('lists both names of a file moved inside packages/', () => {
    const { root } = repo();
    renameSync(join(root, 'packages/model/src/a.ts'), join(root, 'packages/model/src/c.ts'));
    commit(root);
    expect(listed(run(root).out)).toEqual(['packages/model/src/a.ts', 'packages/model/src/c.ts']);
  });

  it('judges the net diff: a package edit a later commit reverts passes', () => {
    const { root } = repo();
    commit(root, { 'packages/model/src/a.ts': 'export const a = 2;\n' });
    commit(root, { 'packages/model/src/a.ts': 'export const a = 1;\n' });
    expect(run(root).status).toBe(0);
  });

  it('counts an earlier commit of the branch, not only the last one', () => {
    const { root } = repo();
    commit(root, { 'packages/model/src/a.ts': 'export const a = 2;\n' });
    commit(root, { 'apps/vscode/src/x.ts': 'export const x = 2;\n' });
    const { status, out } = run(root);
    expect(listed(out)).toEqual(['packages/model/src/a.ts']);
    expect(status).toBe(1);
  });

  it('does not count what the base gained after the branch left it', () => {
    const { root, base } = repo();
    const ahead = commit(root, { 'packages/model/src/a.ts': 'export const a = 3;\n' });
    setBase(root, ahead);
    git(root, 'reset', '-q', '--hard', base);
    commit(root, { 'apps/vscode/src/x.ts': 'export const x = 2;\n' });
    expect(run(root)).toMatchObject({ status: 0 });
  });

  // actions/checkout checks a pull request out as the merge of its head into its base.
  it.each([
    ['apps/vscode/src/x.ts', 0],
    ['packages/model/src/b.ts', 1],
  ])('judges the merge commit CI checks out: a change to %s exits %i', (path, expected) => {
    const { root, base } = repo();
    const tip = commit(root, { 'packages/model/src/a.ts': 'export const a = 3;\n' });
    setBase(root, tip);
    git(root, 'checkout', '-q', '-b', 'topic', base);
    commit(root, { [path]: 'export const changed = 1;\n' });
    git(root, 'checkout', '-q', '--detach', tip);
    git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'topic');
    // Not 'head': a case-insensitive filesystem reads it as HEAD, and the merge does nothing.
    expect(git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    const { status, out } = run(root);
    expect(listed(out)).toEqual(expected === 1 ? [path] : []);
    expect(status).toBe(expected);
  });
});

// Round two (review a4, a5).
describe('what is judged', () => {
  it('the commits, not the working tree: an uncommitted package edit passes', () => {
    const { root } = repo();
    commit(root, { 'apps/vscode/src/x.ts': 'export const x = 2;\n' });
    write(root, {
      'packages/model/src/a.ts': 'export const a = 2;\n',
      'packages/model/src/untracked.ts': 'export const u = 1;\n',
    });
    git(root, 'add', 'packages/model/src/a.ts');
    expect(run(root)).toMatchObject({ status: 0 });
  });

  it('without an argument, the repository the script is in, wherever it is started', () => {
    const { root } = repo();
    commit(root, {
      'packages/model/src/a.ts': 'export const a = 2;\n',
      'tools/check-unit-diff.mjs': readFileSync(SCRIPT, 'utf8'),
    });
    const r = spawnSync(process.execPath, [join(root, 'tools/check-unit-diff.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...CLEAN_ENV, GITHUB_HEAD_REF: HEAD, GITHUB_BASE_REF: BASE },
    });
    expect(listed(`${r.stdout}${r.stderr}`)).toEqual(['packages/model/src/a.ts']);
    expect(r.status).toBe(1);
  });
});

describe('any other branch', () => {
  it.each(['fix/u3-prep-engine', 'feat/u30.1', 'feat/u3-x', 'x/feat/u3.1', 'feat/u4.1.2-coalesce'])(
    '%s passes whatever it changes, with a line saying the rule does not apply',
    (head) => {
      const { root } = repo();
      commit(root, { 'packages/model/src/a.ts': 'export const a = 2;\n' });
      const { status, out } = run(root, { GITHUB_HEAD_REF: head, GITHUB_BASE_REF: BASE });
      expect(out).toContain(`check-unit-diff: the rule does not apply to ${head}`);
      expect(status).toBe(0);
    },
  );

  // Round two (review a7): nothing about the base matters there, so nothing is asked of it.
  it.each([{}, { GITHUB_BASE_REF: '' }, { GITHUB_BASE_REF: 'never-fetched' }])(
    'passes whatever the base is (%j)',
    (base) => {
      const { root } = repo();
      const { status, out } = run(root, { GITHUB_HEAD_REF: 'fix/u3-prep-engine', ...base });
      expect(out).toContain('check-unit-diff: the rule does not apply to fix/u3-prep-engine');
      expect(status).toBe(0);
    },
  );

  it.each([{}, { GITHUB_HEAD_REF: '', GITHUB_BASE_REF: '' }])(
    'no pull request at all (%j) passes the same way',
    (refs) => {
      const { root } = repo();
      commit(root, { 'packages/model/src/a.ts': 'export const a = 2;\n' });
      const { status, out } = run(root, refs);
      expect(out).toContain('check-unit-diff: the rule does not apply');
      expect(status).toBe(0);
    },
  );
});

describe('a feat/u3.* pull request that cannot be judged fails, naming the base', () => {
  it.each([{ GITHUB_HEAD_REF: HEAD }, { GITHUB_HEAD_REF: HEAD, GITHUB_BASE_REF: '' }])(
    'GITHUB_BASE_REF missing (%j)',
    (refs) => {
      const { root } = repo();
      const { status, out } = run(root, refs);
      expect(out).toContain('GITHUB_BASE_REF');
      expect(status).toBe(1);
    },
  );

  it('a base that was never fetched', () => {
    const { root } = repo();
    const { status, out } = run(root, { GITHUB_HEAD_REF: HEAD, GITHUB_BASE_REF: 'gone' });
    expect(out).toContain('check-unit-diff: cannot compare with origin/gone');
    expect(status).toBe(1);
  });

  it('a base with no commit in common', () => {
    const { root } = repo();
    git(root, 'checkout', '-q', '--orphan', 'other');
    const orphan = commit(root, { 'apps/vscode/src/x.ts': 'export const x = 9;\n' });
    git(root, 'checkout', '-q', 'work');
    setBase(root, orphan);
    const { status, out } = run(root);
    expect(out).toContain(`check-unit-diff: cannot compare with origin/${BASE}`);
    expect(status).toBe(1);
  });
});

describe('the refs never reach a shell', () => {
  it.each([
    [`${HEAD}$(touch pwned)`, BASE, 0],
    [HEAD, 'gone;touch pwned', 1],
    [HEAD, '$(touch pwned)', 1],
    // Round two (review a6): quotes, which a quoted interpolation would let through.
    [HEAD, "gone';touch pwned;'", 1],
    [HEAD, 'gone";touch pwned;"', 1],
    [`${HEAD}';touch pwned;'`, BASE, 0],
  ])('head %s, base %s exits %i and runs nothing', (head, base, expected) => {
    const { root } = repo();
    const { status, out } = run(root, { GITHUB_HEAD_REF: head, GITHUB_BASE_REF: base });
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    expect(out).toContain(expected === 0 ? `ok: ${head} ` : `cannot compare with origin/${base}`);
    expect(status).toBe(expected);
  });
});

describe('the wiring', () => {
  const steps = parse(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8')).jobs.check
    .steps;

  it('the CI check job runs it on pull requests only, over the full history', () => {
    const own = steps.filter((step) => step.run === 'bun run check:unit-diff');
    expect(own.map((step) => step.if)).toEqual(["${{ github.event_name == 'pull_request' }}"]);
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0 });
  });

  it('bun run check:unit-diff is this script', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(scripts['check:unit-diff']).toBe('node tools/check-unit-diff.mjs');
  });
});
