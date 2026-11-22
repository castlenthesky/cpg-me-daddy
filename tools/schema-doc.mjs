#!/usr/bin/env node
// Regenerates (or, with --check, verifies) the BEGIN/END GENERATED region of docs/outline/04-schema.yaml
// from CPG_SCHEMA (U1.1.2). Usage: node tools/schema-doc.mjs [--check] [--file <path>]
// Exit 0: up to date / written. Exit 1: drift (--check), malformed markers, unreadable file, build failure.
// Exit 2: unknown argument. --file is the test seam (prove-gates runs on the real file or a temp copy).
// The model is built first (`tsc -b packages/model`) and loaded from its CommonJS dist via createRequire.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node tools/schema-doc.mjs [--check] [--file <path>]';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

let check = false;
let file = join(root, 'docs/outline/04-schema.yaml');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--check') check = true;
  else if (arg === '--file' && i + 1 < argv.length) file = resolve(argv[++i]);
  else fail(`schema-doc: unknown argument ${arg}\n${USAGE}`, 2);
}

let existing;
try {
  existing = readFileSync(file, 'utf8');
} catch {
  fail(`schema-doc: cannot read ${file}`);
}

const build = spawnSync('bun', ['run', '--silent', 'tsc', '-b', 'packages/model'], {
  cwd: root,
  encoding: 'utf8',
});
if (build.status !== 0)
  fail(`schema-doc: building @cpg/model failed\n${build.stdout}${build.stderr}`);

const { CPG_SCHEMA, renderSchemaRegion, spliceGeneratedRegion } = createRequire(import.meta.url)(
  join(root, 'packages/model'),
);

let next;
try {
  next = spliceGeneratedRegion(existing, renderSchemaRegion(CPG_SCHEMA));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

if (next === existing) {
  console.log(`schema-doc: ${file} is up to date`);
} else if (check) {
  const a = existing.split('\n');
  const b = next.split('\n');
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) line++;
  fail(
    `schema-doc: ${file} generated region is stale (first difference at line ${line + 1}); run \`bun run schema:doc\``,
  );
} else {
  writeFileSync(file, next);
  console.log(`schema-doc: regenerated ${file}`);
}
