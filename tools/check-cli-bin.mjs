#!/usr/bin/env node
// The declared bin is EXECUTED (C-CLI I-6): the archived bin was never once run. Builds apps/cli,
// then spawns the built dist/main.js the way an installed `cpg` runs, and asserts what it does.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// main.ts is the composition root: createEngine wired with the MemoryStore sink (BMO-79).
const ws = mkdtempSync(join(tmpdir(), 'cpg-cli-bin-'));
try {
  writeFileSync(join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'b.py'), 'b = 2\n');
  expectRun(['index', '--dry-run', ws], 0, 'stdout', /^files seen=2 indexed=2 /m);
  // no root given: main.ts hands run() process.cwd(), the last workspace-root fallback
  expectRun(['index', '--dry-run'], 0, 'stdout', /^files seen=2 indexed=2 /m, ws);
  // verify through the bin reads main.ts's own MemoryStore, which nothing has indexed in this
  // process (U2a.3 known gap: no store outlives a process before U5). filesystem-reconciliation
  // fails, and that is exit 3 (never 1) with exactly one cpg.verify.report document on stdout.
  const v = expectRun(['verify', '--format=json', ws], 3, 'stdout', /^\{.*\}\n$/);
  try {
    const doc = JSON.parse(v.stdout);
    const fs = doc.body.checks.find((c) => c.id === 'filesystem-reconciliation');
    if (doc.kind !== 'cpg.verify.report' || doc.body.checks.length !== 6 || fs?.state !== 'fail')
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
