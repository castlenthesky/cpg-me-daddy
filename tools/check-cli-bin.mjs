#!/usr/bin/env node
// The declared bin is EXECUTED (C-CLI I-6): the archived bin was never once run. Builds apps/cli,
// then spawns the built dist/main.js the way an installed `cpg` runs, and asserts what it does.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

// The bin reads CPG_WORKSPACE (the workspace root's fallback before cwd), CPG_HOST/PORT/GRAPH (the
// config's env layer, U2c.1) and CPG_GRAMMAR_DIR (the grammar directory, U6a.3-2): a value in the
// caller's shell would redirect the cases below.
const env = { ...process.env };
for (const name of ['CPG_WORKSPACE', 'CPG_HOST', 'CPG_PORT', 'CPG_GRAPH', 'CPG_GRAMMAR_DIR'])
  delete env[name];
const errors = [];
function expectRun(args, status, stream, pattern, cwd = ROOT, extraEnv = {}) {
  const r = spawnSync(process.execPath, [`${APP}/${binPath}`, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
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
// Grammar directories for the code-tier cases, outside the workspace the cases index.
const aside = mkdtempSync(join(tmpdir(), 'cpg-cli-bin-grammars-'));
try {
  // .git bounds the config search (U2c.1): a stray cpg.config.yaml above tmpdir is never read.
  mkdirSync(join(ws, '.git'));
  writeFileSync(join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'b.py'), 'b = 2\n');
  expectRun(['index', '--dry-run', ws], 0, 'stdout', /^files seen=2 indexed=2 /m);
  // no root given: main.ts hands run() process.cwd(), the last workspace-root fallback
  expectRun(['index', '--dry-run'], 0, 'stdout', /^files seen=2 indexed=2 /m, ws);
  // cpg index without --dry-run writes the engine-built memory store (U2c.2): the root DIRECTORY
  // and two FILEs, two HAS_ENTRY; then b.py's replace-file (U6a.3-2): its MODULE, module SYMBOL and
  // FILE rows, DEFINES and SOURCE_FILE.
  expectRun(['index', ws], 0, 'stdout', /^written nodes=6 edges=4 dryRun=false$/m);
  // The code tier at runtime (U6a.3-2, controller decision 100): the built bin finds the python
  // grammar through its own package, and main.ts hands the engine CPG_GRAMMAR_DIR resolved against
  // its cwd; an empty value is unset, and a directory without the grammar is one warning, exit 0.
  const codeTier = (label, extraEnv, cwd = ROOT) => {
    const r = expectRun(
      ['index', '--dry-run', '--format', 'json', ws],
      0,
      'stdout',
      /^\{.*\}\n$/,
      cwd,
      extraEnv,
    );
    try {
      const body = JSON.parse(r.stdout).body;
      const b = body.files.find((f) => f.path === 'b.py');
      return { nodes: b?.nodes, edges: b?.edges, warnings: body.warnings };
    } catch (e) {
      errors.push(
        `cpg index (${label}): stdout is not one JSON document (${String(e)}): ${r.stdout}`,
      );
      return { nodes: undefined, edges: undefined, warnings: [] };
    }
  };
  // `missing`: the grammar file the one code-tier warning must name (round two, review 15: matched
  // with includes, so a temp path's own characters never act as a pattern).
  const unavailable =
    'code tier: 1 python file at the FILE tier only (grammar-unavailable): b.py: ';
  const expectCode = (label, got, nodes, edges, missing) => {
    const warned = got.warnings.filter((w) => w !== 'no extractor for typescript yet (U6b)');
    const ok =
      got.nodes === nodes &&
      got.edges === edges &&
      got.warnings.includes('no extractor for typescript yet (U6b)') &&
      (missing === undefined
        ? warned.length === 0
        : warned.length === 1 && warned[0].startsWith(unavailable) && warned[0].includes(missing));
    if (!ok)
      errors.push(
        `cpg index (${label}): expected b.py nodes=${nodes} edges=${edges} and ${missing === undefined ? 'no code-tier warning' : `a warning naming ${missing}`}, got ${JSON.stringify(got)}`,
      );
  };
  const wasmDir = join(
    dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm/package.json')),
    'wasm',
  );
  const empty = join(aside, 'no-grammars');
  mkdirSync(empty);
  const home = join(aside, 'cwd');
  mkdirSync(join(home, 'grammars'), { recursive: true });
  mkdirSync(join(home, 'no-grammars'));
  cpSync(
    join(wasmDir, 'tree-sitter-python.wasm'),
    join(home, 'grammars', 'tree-sitter-python.wasm'),
  );
  expectCode('the package anchor', codeTier('the package anchor', {}), 1, 2);
  expectCode(
    'CPG_GRAMMAR_DIR empty',
    codeTier('CPG_GRAMMAR_DIR empty', { CPG_GRAMMAR_DIR: '' }),
    1,
    2,
  );
  expectCode(
    'CPG_GRAMMAR_DIR relative to the cwd',
    codeTier('CPG_GRAMMAR_DIR relative', { CPG_GRAMMAR_DIR: 'grammars' }, home),
    1,
    2,
  );
  expectCode(
    'CPG_GRAMMAR_DIR without the grammar',
    codeTier('CPG_GRAMMAR_DIR without the grammar', { CPG_GRAMMAR_DIR: empty }),
    0,
    0,
    join(empty, 'tree-sitter-python.wasm'),
  );
  // round two (review 14): a relative value without the grammar names the cwd-resolved file, so a
  // main.ts that dropped relative values (the package anchor would answer) fails
  expectCode(
    'CPG_GRAMMAR_DIR relative, without the grammar',
    codeTier('CPG_GRAMMAR_DIR relative, empty', { CPG_GRAMMAR_DIR: 'no-grammars' }, home),
    0,
    0,
    join(home, 'no-grammars', 'tree-sitter-python.wasm'),
  );
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
  rmSync(aside, { recursive: true, force: true });
}

if (errors.length) {
  console.error(
    `check-cli-bin: ${errors.length} failure(s)\n${errors.map((e) => `  ${e}`).join('\n')}`,
  );
  process.exit(1);
}
console.log('check-cli-bin: ok');
