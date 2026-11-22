#!/usr/bin/env node
// Tarball gate: asserts what `bun pm pack` would actually ship, not what the source tree looks like.
//  1. No workspace tarball may contain a test file (*.test.*, *.test-d.*, *.spec.*).
//  2. @cpg/model's shipped .js files may only require/import relative modules (zero runtime deps,
//     enforced on build output; tools/check-deps.mjs only sees source and exempts test files).
// Needs a fresh build (turbo runs //#typecheck first).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TEST_FILE = /\.test(-d)?\.|\.spec\./;
const SPEC = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const PACKED = /^packed\s+\S+\s+(.+)$/;
const ZERO_DEP = new Set(['@cpg/model']);

const errors = [];
for (const dir of readdirSync(`${ROOT}/packages`)) {
  const pj = `${ROOT}/packages/${dir}/package.json`;
  if (!existsSync(pj)) continue;
  const name = JSON.parse(readFileSync(pj, 'utf8')).name;
  const r = spawnSync('bun', ['pm', 'pack', '--dry-run', '--ignore-scripts'], {
    cwd: `${ROOT}/packages/${dir}`,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    errors.push(`${name}: bun pm pack failed\n${r.stderr}`);
    continue;
  }
  const files = r.stdout
    .split('\n')
    .map((line) => PACKED.exec(line)?.[1])
    .filter(Boolean);
  if (files.length === 0) {
    errors.push(`${name}: bun pm pack listed no files\n${r.stdout}`);
    continue;
  }
  for (const f of files.filter((p) => TEST_FILE.test(p)))
    errors.push(`${name}: tarball contains test file ${f}`);
  if (!ZERO_DEP.has(name)) continue;
  for (const f of files.filter((p) => /\.[cm]?js$/.test(p))) {
    const src = readFileSync(`${ROOT}/packages/${dir}/${f}`, 'utf8');
    for (const m of src.matchAll(SPEC))
      if (!m[1].startsWith('.'))
        errors.push(`${name}: ${f} loads non-relative module '${m[1]}' (zero runtime deps)`);
  }
}
if (errors.length) {
  console.error(`check:pack failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log('check:pack ok');
