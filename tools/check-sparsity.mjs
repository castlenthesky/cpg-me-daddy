#!/usr/bin/env node
// Structural sparsity gate (C-EXTRACT I15 and Q6; U6a.3 "CI asserts structural nodes/LOC <= 1.5 over
// the fixture corpus"; controller decision 101).
// Usage: node tools/check-sparsity.mjs [corpus] [--report <cpg.index.report.json>]
//
// The corpus defaults to the repository's fixtures/ladder; a given one is resolved against the cwd.
// Either way `<corpus>` below is that absolute path. Without --report the tool builds apps/cli (`tsc -b`, a no-op
// when current) and runs the built bin the way an installed `cpg` runs:
// `node apps/cli/dist/main.js index <corpus> --dry-run --format json`, cwd the repository, with this
// process's environment (so CPG_GRAMMAR_DIR reaches it). `--report <file>` reads that document from
// the file instead and runs nothing (a test seam).
//
// - Adapter files: the report body's files whose path ends with one of ADAPTER_EXTENSIONS (`.py`
//   until U6b). Their structural nodes are `nodes` (the engine never asks for the expression tier).
//   Every other file is ignored.
// - LOC per adapter file, read from `<corpus>/<path>` with the engine's rule: 0 for an empty file,
//   else `text.split('\n').length` of its UTF-8 text.
// - Density is nodes / LOC, printed with 3 decimals (`toFixed(3)`); nodes over 0 LOC is Infinity.
// - Failures, each one line on stderr, then exit 1:
//   - `check-sparsity: cpg index failed (exit <n>): <its stderr>` when the bin exits non-zero, and
//     `check-sparsity: no cpg.index.report document` when its stdout (or the --report file) is not
//     one JSON document of kind cpg.index.report;
//   - `check-sparsity: <corpus>: no adapter files` when there are none;
//   - `check-sparsity: <corpus>/<path>: no code-tier nodes` for each adapter file with 0 nodes (a
//     code tier that never ran would otherwise pass);
//   - `check-sparsity: <corpus>: structural density <d> n/LOC is over the bar 1.5` when
//     sum(nodes) / sum(LOC) over the adapter files is over BAR (1.5).
// - Per adapter file with LOC > 0 and nodes / LOC over BAR: `check-sparsity: warning: <path> <d>
//   n/LOC` on stderr, never a failure (Q6: a generated file must not train people to disable it).
// - stderr order: the warnings in the report's file order, then the failures in the order above
//   (the no-code-tier-nodes lines in the report's file order).
// - On success, one line on stdout:
//   `check-sparsity: <nodes> nodes / <loc> LOC = <d> n/LOC over <files> files (bar 1.5)`.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ADAPTER_EXTENSIONS = ['.py'];
const BAR = 1.5;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UTF8_DECODER = new TextDecoder('utf-8');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { report: { type: 'string' } },
  allowPositionals: true,
  strict: true,
});

const corpus =
  positionals[0] !== undefined ? resolve(positionals[0]) : join(ROOT, 'fixtures', 'ladder');
const reportPath = values.report;

function formatDensity(value) {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

let rawReport;
if (reportPath !== undefined) {
  try {
    rawReport = readFileSync(reportPath, 'utf8');
  } catch {
    console.error('check-sparsity: no cpg.index.report document');
    process.exit(1);
  }
} else {
  const build = spawnSync('bun', ['run', '--silent', 'tsc', '-b', 'apps/cli'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    console.error(`check-sparsity: build failed\n${build.stdout}${build.stderr}`);
    process.exit(1);
  }

  const appDir = join(ROOT, 'apps', 'cli');
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  const [, binPath] = Object.entries(pkg.bin)[0];

  const run = spawnSync(
    process.execPath,
    [join(appDir, binPath), 'index', corpus, '--dry-run', '--format', 'json'],
    { cwd: ROOT, env: process.env, encoding: 'utf8' },
  );
  if (run.status !== 0) {
    console.error(
      `check-sparsity: cpg index failed (exit ${String(run.status)}): ${run.stderr.trim()}`,
    );
    process.exit(1);
  }
  rawReport = run.stdout;
}

let doc;
try {
  doc = JSON.parse(rawReport);
} catch {
  console.error('check-sparsity: no cpg.index.report document');
  process.exit(1);
}

if (
  typeof doc !== 'object' ||
  doc === null ||
  doc.kind !== 'cpg.index.report' ||
  typeof doc.body !== 'object' ||
  doc.body === null ||
  !Array.isArray(doc.body.files)
) {
  console.error('check-sparsity: no cpg.index.report document');
  process.exit(1);
}

const adapterFiles = doc.body.files.filter(
  (file) =>
    typeof file === 'object' &&
    file !== null &&
    typeof file.path === 'string' &&
    typeof file.nodes === 'number' &&
    ADAPTER_EXTENSIONS.some((ext) => file.path.endsWith(ext)),
);

if (adapterFiles.length === 0) {
  console.error(`check-sparsity: ${corpus}: no adapter files`);
  process.exit(1);
}

const warnings = [];
const failures = [];
let totalNodes = 0;
let totalLoc = 0;

for (const file of adapterFiles) {
  const text = UTF8_DECODER.decode(readFileSync(join(corpus, ...file.path.split('/'))));
  const fileLoc = text.length === 0 ? 0 : text.split('\n').length;
  totalNodes += file.nodes;
  totalLoc += fileLoc;

  if (fileLoc > 0) {
    const fileDensity = file.nodes / fileLoc;
    if (fileDensity > BAR) {
      warnings.push(`check-sparsity: warning: ${file.path} ${formatDensity(fileDensity)} n/LOC`);
    }
  }
  if (file.nodes === 0) {
    failures.push(`check-sparsity: ${corpus}/${file.path}: no code-tier nodes`);
  }
}

const density = totalLoc === 0 ? (totalNodes > 0 ? Infinity : 0) : totalNodes / totalLoc;
if (density > BAR) {
  failures.push(
    `check-sparsity: ${corpus}: structural density ${formatDensity(density)} n/LOC is over the bar ${String(BAR)}`,
  );
}

for (const line of warnings) {
  console.error(line);
}
if (failures.length > 0) {
  for (const line of failures) {
    console.error(line);
  }
  process.exit(1);
}

console.log(
  `check-sparsity: ${String(totalNodes)} nodes / ${String(totalLoc)} LOC = ${formatDensity(density)} n/LOC over ${String(adapterFiles.length)} files (bar ${String(BAR)})`,
);
