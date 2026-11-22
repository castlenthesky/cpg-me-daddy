#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit): reads hook JSON on stdin, then
// formats (silently, write) and lints the single edited file.
// Exit 2 + stderr is Claude Code's convention for feeding a problem back to the agent;
// every other situation (outside repo, deleted file, other extension, bad input) exits 0
// so the hook can never block or break an edit.
// Calls the local binaries directly to stay fast.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.json']);
// oxlint only understands JS/TS; running it on .json fails with "No files found to lint".
const LINT_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs']);
// Same exclusions as .oxfmtrc.json / .oxlintrc.json; the tools skip them anyway, this saves a spawn.
const SKIP = /(^|\/)(node_modules|dist|out|docs|coverage|reports|\.turbo)\//;

let input = '';
for await (const chunk of process.stdin) input += chunk;

let file;
try {
  file = JSON.parse(input)?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (typeof file !== 'string' || file === '') process.exit(0);

const abs = isAbsolute(file) ? file : resolve(ROOT, file);
const rel = relative(ROOT, abs);
if (rel.startsWith('..') || isAbsolute(rel)) process.exit(0); // outside the repo
if (!EXTS.has(extname(abs)) || SKIP.test(rel) || !existsSync(abs)) process.exit(0);

const bin = (name) => `${ROOT}/node_modules/.bin/${name}`;
const run = (name, args) => spawnSync(bin(name), args, { cwd: ROOT, encoding: 'utf8' });

run('oxfmt', ['--write', rel]); // result ignored: formatting is applied silently
if (!LINT_EXTS.has(extname(abs))) process.exit(0);
const lint = run('oxlint', ['--deny-warnings', rel]);
if (lint.error || lint.status === 0) process.exit(0);

process.stderr.write(`oxlint failed on ${rel}:\n${lint.stdout}${lint.stderr}`);
process.exit(2);
