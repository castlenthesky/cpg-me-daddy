#!/usr/bin/env node
// Resolves every archive coordinate cited in docs/outline (`bun run check:coords`).
//
// A coordinate is `<sha>:<path>` (7-40 hex chars), or in 11-salvage.yaml the shorthand `M:<path>`
// whose letter its `# Commit shorthand:` header maps to a SHA. A path may carry brace sets
// (`{nodes,edges}.ts`), `*` / `**` globs, and a `:line` or `:from-to` suffix (dropped). Every
// expansion must exist in that commit; a glob must match at least one file.
//
// It also checks each `archive_commits` row in 10-lessons.yaml: the commit must be on the branch
// named beside it, because that branch is what keeps it from being garbage-collected.
//
// Run: bun run check:coords. Needs full history (CI checks out with fetch-depth: 0).

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DOCS = join(ROOT, 'docs/outline');

const PATH = String.raw`(?:[\w.\-/*]|\{[^}\s]*\})+`;
const COORD = new RegExp(String.raw`(?<![\w/])([0-9a-f]{7,40}|[A-Z]):(${PATH})`, 'g');

/** `a/{b,c}/d{1,2}` -> every combination. Nested braces are not used and not supported. */
export function expandBraces(path) {
  const m = /\{([^{}]*)\}/.exec(path);
  if (!m) return [path];
  const head = path.slice(0, m.index);
  const tail = path.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

/** Glob to an anchored regex: `**` crosses directories, `*` does not. */
export function globToRegExp(glob) {
  const body = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${body}$`);
}

/** Every coordinate in a file's text: [{ ref, path, line }]. `short` maps shorthand letters. */
export function extractCoords(text, short = {}) {
  const out = [];
  text.split('\n').forEach((lineText, i) => {
    for (const m of lineText.matchAll(COORD)) {
      const [, key, raw] = m;
      const ref = /^[A-Z]$/.test(key) ? short[key] : key;
      if (!ref) continue; // a capital letter + colon that is not a declared shorthand
      // Trailing prose punctuation and a `:line` suffix are not part of the path.
      const path = raw.replace(/[.,;]+$/, '');
      if (!path.includes('/') && !path.includes('.')) continue; // `abc1234:x` in prose
      out.push({ ref, path, line: i + 1 });
    }
  });
  return out;
}

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const treeCache = new Map();
function filesAt(ref) {
  if (!treeCache.has(ref)) {
    const r = git(['ls-tree', '-r', '--name-only', ref]);
    treeCache.set(ref, r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null);
  }
  return treeCache.get(ref);
}

function resolves(ref, path) {
  const files = filesAt(ref);
  if (!files) return `commit ${ref} is not in this clone`;
  for (const p of expandBraces(path)) {
    if (p.includes('*')) {
      const re = globToRegExp(p);
      if (!files.some((f) => re.test(f))) return `${p} matches nothing`;
    } else if (git(['cat-file', '-e', `${ref}:${p}`]).status !== 0) {
      return `${p} does not exist`;
    }
  }
  return null;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function main() {
  const problems = [];
  let count = 0;
  for (const file of walk(DOCS)) {
    const text = readFileSync(file, 'utf8');
    const header = /^# Commit shorthand: (.*)$/m.exec(text);
    const short = header
      ? Object.fromEntries(
          [...header[1].matchAll(/\b([A-Z]) = ([0-9a-f]{7,40})\b/g)].map((m) => [m[1], m[2]]),
        )
      : {};
    for (const c of extractCoords(text, short)) {
      count++;
      const why = resolves(c.ref, c.path);
      if (why) problems.push(`${relative(ROOT, file)}:${c.line}  ${c.ref}:${c.path}  (${why})`);
    }
  }

  const lessons = readFileSync(join(DOCS, '10-lessons.yaml'), 'utf8');
  const rows = [...lessons.matchAll(/\{ commit: ([0-9a-f]{40}), branch: (\S+),/g)];
  if (rows.length === 0)
    problems.push('docs/outline/10-lessons.yaml: no archive_commits rows found');
  for (const [, sha, branch] of rows) {
    if (git(['merge-base', '--is-ancestor', sha, branch]).status !== 0)
      problems.push(`docs/outline/10-lessons.yaml  ${sha} is not on ${branch} (nothing keeps it)`);
  }

  if (problems.length) {
    console.error(`check:coords: ${problems.length} unresolved archive coordinate(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`check:coords ok (${count} coordinates, ${rows.length} archive commits)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
