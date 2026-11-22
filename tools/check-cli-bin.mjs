#!/usr/bin/env node
// The declared bin is EXECUTED (C-CLI I-6): the archived bin was never once run. Builds apps/cli,
// then spawns the built dist/main.js the way an installed `cpg` runs, and asserts what it does.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

// The bin reads CPG_WORKSPACE (the workspace root's fallback before cwd) and CPG_HOST/PORT/GRAPH (the
// config's env layer, U2c.1): a value in the caller's shell would redirect the cases below.
const env = { ...process.env };
for (const name of ['CPG_WORKSPACE', 'CPG_HOST', 'CPG_PORT', 'CPG_GRAPH']) delete env[name];
const errors = [];
function expectRun(args, status, stream, pattern, cwd = ROOT) {
  const r = spawnSync(process.execPath, [`${APP}/${binPath}`, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  const text = r[stream];
  if (r.status !== status || !pattern.test(text))
    errors.push(
      `cpg ${args.join(' ')}: expected exit ${status} and ${stream} ${pattern}, got exit ${r.status}: ${JSON.stringify(`${r.stdout}${r.stderr}`)}`,
    );
  return r;
}

const banner = `${binName} ${pkg.version}`.replace(/[.]/g, '\\.');
expectRun(['--version'], 0, 'stdout', new RegExp(`^${banner}\\n$`));
expectRun(['frobnicate'], 2, 'stderr', /unknown command 'frobnicate'/);
expectRun(['mcp'], 2, 'stderr', /not built yet/);
// main.ts is the composition root: run() calls createEngine once the config has resolved, and the
// engine builds its own sinks from the consumer switches (owner decision 5a, U2c.2).
const ws = mkdtempSync(join(tmpdir(), 'cpg-cli-bin-'));
try {
  // .git bounds the config search (U2c.1): a stray cpg.config.yaml above tmpdir is never read.
  mkdirSync(join(ws, '.git'));
  writeFileSync(join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'b.py'), 'b = 2\n');
  expectRun(['index', '--dry-run', ws], 0, 'stdout', /^files seen=2 indexed=2 /m);
  // no root given: main.ts hands run() process.cwd(), the last workspace-root fallback
  expectRun(['index', '--dry-run'], 0, 'stdout', /^files seen=2 indexed=2 /m, ws);
  // cpg index without --dry-run writes the engine-built memory store (U2c.2): the root DIRECTORY
  // and two FILEs, two HAS_ENTRY.
  expectRun(['index', ws], 0, 'stdout', /^written nodes=3 edges=2 dryRun=false$/m);
  expectRun(['index', ws], 0, 'stderr', /consumers: memory$/m);
  // a switched-on consumer that is not built yet is exit 2 "not built yet", naming its source
  expectRun(['index', '--store', 'falkor', ws], 2, 'stderr', /not built yet.*--store/s);
  // verify indexes first (owner decision 2A), so the bin passes on a workspace nothing indexed
  // before: exit 0, one cpg.verify.report document whose store checks pass. Headless, so
  // render-reconciliation is unavailable.
  const v = expectRun(['verify', '--format=json', ws], 0, 'stdout', /^\{.*\}\n$/);
  try {
    const doc = JSON.parse(v.stdout);
    const state = (id) => doc.body.checks.find((c) => c.id === id)?.state;
    const passing = ['filesystem-reconciliation', 'id-uniqueness', 'revision-reconciliation'];
    if (
      doc.kind !== 'cpg.verify.report' ||
      doc.body.checks.length !== 6 ||
      passing.some((id) => state(id) !== 'pass') ||
      state('render-reconciliation') !== 'unavailable' ||
      JSON.stringify(doc.body.consumers) !== '["memory"]'
    )
      errors.push(`cpg verify --format=json: unexpected document ${v.stdout}`);
  } catch (e) {
    errors.push(
      `cpg verify --format=json: stdout is not one JSON document (${String(e)}): ${v.stdout}`,
    );
  }
  // cpg schema (U2a.4): --print is CPG_SCHEMA as one cpg.schema document, and --check on this
  // repository gives check:schema's verdict (both decide drift with @cpg/model's checkSchemaDoc).
  const s = expectRun(['schema', '--print'], 0, 'stdout', /^\{.*\}\n$/);
  try {
    const doc = JSON.parse(s.stdout);
    // The model is built by the apps/cli build above (a project reference).
    const { CPG_SCHEMA } = createRequire(import.meta.url)(join(ROOT, 'packages/model'));
    if (doc.kind !== 'cpg.schema' || JSON.stringify(doc.body) !== JSON.stringify(CPG_SCHEMA))
      errors.push(`cpg schema --print: the document is not CPG_SCHEMA: ${s.stdout.slice(0, 200)}`);
  } catch (e) {
    errors.push(`cpg schema --print: stdout is not one JSON document (${String(e)})`);
  }
  // the ladder fixtures, a real multi-directory tree: verify exits 0 through the bin. A copy under a
  // .git-bounded dir, so a stray cpg.config.yaml at the repository root is never read.
  const ladder = join(ws, 'ladder');
  cpSync(join(ROOT, 'fixtures', 'ladder'), ladder, { recursive: true });
  mkdirSync(join(ladder, '.git'));
  expectRun(['verify', ladder], 0, 'stdout', /^verify unavailable$/m);
  expectRun(['schema', '--check'], 0, 'stderr', /up to date/);
  expectRun(['schema', '--check', '--workspace', ws], 1, 'stderr', /cannot read/);
  // cpg config (U2c.1): one cpg.config.resolved document. The workspace has a cpg.config.yaml, so
  // this also proves the built bin loads the engine's yaml and zod at runtime.
  const cws = join(ws, 'configured');
  mkdirSync(join(cws, '.git'), { recursive: true });
  writeFileSync(
    join(cws, 'cpg.config.yaml'),
    'version: 1\nstore: { falkor: { graph: bin-graph } }\n',
  );
  const c = expectRun(['config', '--format=json', cws], 0, 'stdout', /^\{.*\}\n$/);
  try {
    const doc = JSON.parse(c.stdout);
    const graph = doc.body.store.graph;
    if (
      doc.kind !== 'cpg.config.resolved' ||
      doc.body.root.value !== cws ||
      graph.value !== 'bin-graph' ||
      graph.layer !== 'file'
    )
      errors.push(`cpg config --format=json: unexpected document ${c.stdout}`);
  } catch (e) {
    errors.push(`cpg config --format=json: stdout is not one JSON document (${String(e)})`);
  }
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
