// tools/check-sparsity.mjs (C-EXTRACT I15, Q6; U6a.3 "CI asserts structural nodes/LOC <= 1.5 over the
// fixture corpus"). Two cases run the built bin over the ladder; the rest hand the tool a written
// cpg.index.report (--report), since the MODULE-only code tier can never put a file over the bar.
// Expected LOC is computed here with the rule the tool states, from the corpus bytes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'tools', 'check-sparsity.mjs');
const LADDER = join(REPO, 'fixtures', 'ladder');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Round two (review 19): no CPG_GRAMMAR_DIR from the caller's shell, which would move the grammar.
const { CPG_GRAMMAR_DIR: _ambient, ...BASE_ENV } = process.env;
const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    env: { ...BASE_ENV, ...env },
    encoding: 'utf8',
  });
const loc = (text) => (text.length === 0 ? 0 : text.split('\n').length);
const pyFiles = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.py'))
    .map((d) => join(d.parentPath, d.name));

/**
 * U6a.2-3 and U6a.2-4a: the code tier's nodes in the ladder, from its hand-written answer: the
 * [structural] node lines of python files whose label Pass A or Pass B's calls emit (IMPORT is BMO-134).
 */
const EMITTED = new Set(['MODULE', 'TYPE_DECL', 'METHOD', 'PARAM', 'MEMBER', 'UNKNOWN', 'CALL']);
function codeNodes(ladder) {
  let count = 0;
  for (const rung of readdirSync(ladder).filter((name) => /^\d\d-/.test(name))) {
    let section = '';
    for (const raw of readFileSync(join(ladder, rung, 'expected.cpg'), 'utf8').split('\n')) {
      const line = raw.replace(/(^|\s)#.*$/, '').trim();
      const header = /^\[(\w+)\]$/.exec(line);
      if (header) section = header[1];
      const [label = '', id = ''] = line.split(/\s+/);
      if (!header && section === 'structural' && EMITTED.has(label) && /\.py:/.test(id)) count += 1;
    }
  }
  return count;
}

/** A corpus on disk, and a cpg.index.report for it whose files carry `nodes`. */
function corpus(files, nodes) {
  const root = mkdtempSync(join(tmpdir(), 'cpg-sparsity-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const report = join(root, 'report.json');
  const body = {
    files: Object.entries(nodes).map(([path, n]) => ({
      path,
      revision_id: 'r',
      nodes: n,
      edges: 0,
    })),
  };
  writeFileSync(report, JSON.stringify({ v: 1, kind: 'cpg.index.report', body }));
  return { root, report };
}
const lines = (text) => text.split('\n').filter((line) => line !== '');

describe('check-sparsity on the ladder through the built bin', () => {
  it(
    'passes: one summary line of the code tier over every python file',
    { timeout: 120_000 },
    () => {
      const files = pyFiles(LADDER);
      const total = files.reduce((sum, f) => sum + loc(readFileSync(f, 'utf8')), 0);
      const nodes = codeNodes(LADDER);
      const r = run([]);
      expect([r.status, r.stderr]).toEqual([0, '']);
      expect(lines(r.stdout)).toEqual([
        `check-sparsity: ${nodes} nodes / ${total} LOC = ${(nodes / total).toFixed(3)} n/LOC over ${files.length} files (bar 1.5)`,
      ]);
      // 33 Pass A lines and the 6 CALL lines of rungs 04 (2), 06 (1), 07 (1) and 08 (2).
      expect([files.length, nodes]).toEqual([12, 39]);
    },
  );

  it(
    'fails when the code tier never ran (CPG_GRAMMAR_DIR without the grammar)',
    { timeout: 120_000 },
    () => {
      const empty = mkdtempSync(join(tmpdir(), 'cpg-sparsity-empty-'));
      roots.push(empty);
      const r = run([], { CPG_GRAMMAR_DIR: empty });
      expect(r.status).toBe(1);
      const named = pyFiles(LADDER).map(
        (f) => `check-sparsity: ${LADDER}/${relative(LADDER, f)}: no code-tier nodes`,
      );
      // round two (review 17): in the report's file order, which is path order (C-CLI IndexReport)
      expect(lines(r.stderr)).toEqual(named.toSorted());
    },
  );
});

describe('check-sparsity on a written report (--report)', () => {
  it('over the bar: exit 1 naming the corpus density, and a warning for the dense file only', () => {
    // a.py: 4 nodes / 2 LOC; b.py: 1 node / 0 LOC; corpus 5 / 2 = 2.5
    const c = corpus({ 'a.py': 'a\n', 'pkg/b.py': '' }, { 'a.py': 4, 'pkg/b.py': 1 });
    const r = run([c.root, '--report', c.report]);
    expect([r.status, r.stdout]).toEqual([1, '']);
    expect(lines(r.stderr)).toEqual([
      'check-sparsity: warning: a.py 2.000 n/LOC',
      `check-sparsity: ${c.root}: structural density 2.500 n/LOC is over the bar 1.5`,
    ]);
  });

  it('at the bar passes, with no warning; nodes over 0 LOC is over it', () => {
    // a.py 6 / 4 and b.py 3 / 2: each file and the corpus (9 / 6) exactly at 1.5
    const at = corpus({ 'a.py': 'a\nb\nc\n', 'b.py': 'x\ny' }, { 'a.py': 6, 'b.py': 3 });
    const atBar = run([at.root, '--report', at.report]);
    const empty = corpus({ 'a.py': '', 'b.py': '' }, { 'a.py': 1, 'b.py': 1 });
    const zero = run([empty.root, '--report', empty.report]);
    expect([atBar.status, lines(atBar.stdout), lines(atBar.stderr)]).toEqual([
      0,
      ['check-sparsity: 9 nodes / 6 LOC = 1.500 n/LOC over 2 files (bar 1.5)'],
      [],
    ]);
    expect([zero.status, lines(zero.stderr)]).toEqual([
      1,
      [`check-sparsity: ${empty.root}: structural density Infinity n/LOC is over the bar 1.5`],
    ]);
  });

  it('a dense file only warns, and files without an adapter are ignored', () => {
    const long = 'x = 1\n'.repeat(39);
    const c = corpus(
      { 'gen.py': 'a\nb\nc\n', 'lib/big.py': long, 'web.ts': 't', 'notes.txt': 'n' },
      { 'gen.py': 8, 'lib/big.py': 2, 'web.ts': 900 },
    );
    const r = run([c.root, '--report', c.report]);
    // gen.py 8 / 4 = 2.000 warns; corpus (8 + 2) / (4 + 40) = 0.227; web.ts is not counted
    expect([r.status, lines(r.stdout), lines(r.stderr)]).toEqual([
      0,
      ['check-sparsity: 10 nodes / 44 LOC = 0.227 n/LOC over 2 files (bar 1.5)'],
      ['check-sparsity: warning: gen.py 2.000 n/LOC'],
    ]);
  });

  it('vacuity: an adapter file with no nodes fails, and so does a corpus with no adapter file', () => {
    const half = corpus({ 'a.py': 'a', 'b/c.py': 'c' }, { 'a.py': 0, 'b/c.py': 1 });
    const none = corpus({ 'x.ts': 'x' }, { 'x.ts': 3 });
    const h = run([half.root, '--report', half.report]);
    const n = run([none.root, '--report', none.report]);
    expect([h.status, lines(h.stderr)]).toEqual([
      1,
      [`check-sparsity: ${half.root}/a.py: no code-tier nodes`],
    ]);
    expect([n.status, lines(n.stderr)]).toEqual([
      1,
      [`check-sparsity: ${none.root}: no adapter files`],
    ]);
  });

  // Round two (review 17): every kind of line at once, in the stated order, the report unsorted
  it('stderr order: warnings in report order, then each empty file in report order, then the density', () => {
    const c = corpus(
      { 'z.py': 'z\n', 'm.py': 'm', 'a.py': 'a\n', 'k.py': 'k' },
      { 'z.py': 4, 'm.py': 0, 'a.py': 6, 'k.py': 0 },
    );
    const r = run([c.root, '--report', c.report]);
    // z.py 4 / 2 and a.py 6 / 2 warn; the corpus is 10 / 6
    expect([r.status, r.stdout, lines(r.stderr)]).toEqual([
      1,
      '',
      [
        'check-sparsity: warning: z.py 2.000 n/LOC',
        'check-sparsity: warning: a.py 3.000 n/LOC',
        `check-sparsity: ${c.root}/m.py: no code-tier nodes`,
        `check-sparsity: ${c.root}/k.py: no code-tier nodes`,
        `check-sparsity: ${c.root}: structural density 1.667 n/LOC is over the bar 1.5`,
      ],
    ]);
  });

  // Round two (review 18): a file that is not JSON at all is the same failure, not a stack trace
  it('a report that is not JSON fails as no cpg.index.report document', () => {
    const c = corpus({ 'a.py': 'a' }, { 'a.py': 1 });
    writeFileSync(c.report, '{');
    const r = run([c.root, '--report', c.report]);
    expect([r.status, lines(r.stderr)]).toEqual([
      1,
      ['check-sparsity: no cpg.index.report document'],
    ]);
  });

  it('a document that is not a cpg.index.report fails', () => {
    const c = corpus({ 'a.py': 'a' }, { 'a.py': 1 });
    writeFileSync(
      c.report,
      JSON.stringify({ v: 1, kind: 'cpg.verify.report', body: { files: [] } }),
    );
    const r = run([c.root, '--report', c.report]);
    expect([r.status, lines(r.stderr)]).toEqual([
      1,
      ['check-sparsity: no cpg.index.report document'],
    ]);
  });
});

// Round two (review 16): the bin's own failure is reported with its exit code and its stderr.
describe('check-sparsity when cpg index fails', () => {
  it('names the exit code and passes the bin stderr on', { timeout: 120_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'cpg-sparsity-badconfig-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'cpg.config.yaml'), 'version: 99\n');
    writeFileSync(join(root, 'a.py'), 'a = 1\n');
    const r = run([root]);
    expect(r.status).toBe(1);
    expect(r.stderr.startsWith('check-sparsity: cpg index failed (exit 2): ')).toBe(true);
    expect(r.stderr).toContain(join(root, 'cpg.config.yaml'));
  });
});
