#!/usr/bin/env node
// The declared bin is EXECUTED (C-CLI I-6): the archived bin was never once run. Builds apps/cli,
// then spawns the built dist/main.js the way an installed `cpg` runs, and asserts what it does.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const APP = `${ROOT}/apps/cli`;
const pkg = JSON.parse(readFileSync(`${APP}/package.json`, 'utf8'));
const [binName, binPath] = Object.entries(pkg.bin)[0];

const build = spawnSync('bun', ['run', '--silent', 'tsc', '-b', APP], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (build.status !== 0) {
  console.error(`check-cli-bin: build failed\n${build.stdout}${build.stderr}`);
  process.exit(1);
}

const errors = [];
function expectRun(args, status, stream, pattern, cwd = ROOT) {
  const r = spawnSync(process.execPath, [`${APP}/${binPath}`, ...args], { cwd, encoding: 'utf8' });
  const text = r[stream];
  if (r.status !== status || !pattern.test(text))
    errors.push(
      `cpg ${args.join(' ')}: expected exit ${status} and ${stream} ${pattern}, got exit ${r.status}: ${JSON.stringify(`${r.stdout}${r.stderr}`)}`,
    );
}

const banner = `${binName} ${pkg.version}`.replace(/[.]/g, '\\.');
expectRun(['--version'], 0, 'stdout', new RegExp(`^${banner}\\n$`));
expectRun(['frobnicate'], 2, 'stderr', /unknown command 'frobnicate'/);
expectRun(['mcp'], 2, 'stderr', /not built yet/);
// main.ts is the composition root: createEngine wired with the MemoryStore sink (BMO-79).
const ws = mkdtempSync(join(tmpdir(), 'cpg-cli-bin-'));
try {
  writeFileSync(join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'b.py'), 'b = 2\n');
  expectRun(['index', '--dry-run', ws], 0, 'stdout', /^files seen=2 indexed=2 /m);
  // no root given: main.ts hands run() process.cwd(), the last workspace-root fallback
  expectRun(['index', '--dry-run'], 0, 'stdout', /^files seen=2 indexed=2 /m, ws);
} finally {
  rmSync(ws, { recursive: true, force: true });
}

if (errors.length) {
  console.error(
    `check-cli-bin: ${errors.length} failure(s)\n${errors.map((e) => `  ${e}`).join('\n')}`,
  );
  process.exit(1);
}
console.log('check-cli-bin: ok');
