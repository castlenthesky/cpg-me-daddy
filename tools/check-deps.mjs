#!/usr/bin/env node
// Dependency-direction gate.
//
// Three rules, each one a lesson rather than a preference:
//
//  1. CLI PURITY (rank-1 constraint). No package under packages/** may reach
//     `vscode`. The core has to run under plain node, so a VS Code import
//     anywhere in it is a build failure, not a review comment.
//
//  2. @cpg/model IMPORTS NOTHING. It is required from both a CommonJS host and
//     a browser/ESM webview; anything it pulls in gets pulled into whichever
//     side merely wanted the types.
//
//  3. NO DEEP IMPORTS across packages. `@cpg/x/dist/contract` is how the graph
//     vocabulary ended up owned by the renderer package, with four consumers
//     reaching past its front door and a fifth violating the rule silently.
//     Enforced here so it cannot be violated silently again.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP = new Set(['node_modules', 'dist', 'out', '.git', '.vscode-test', '.debate']);
const SPEC = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(full)) acc.push(full);
  }
  return acc;
}

function walkAll(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkAll(full, acc);
    else acc.push(full);
  }
  return acc;
}

const violations = [];
function flag(file, line, rule, detail) {
  violations.push(`${relative(ROOT, file)}:${line}  [${rule}] ${detail}`);
}

// Scan BOTH trees. packages/** is core and must be vscode-free; src/** is the
// extension host, which is the one place a `vscode` import is legitimate — but
// it still gets the NUL-byte and deep-import rules, and scanning it is how we
// notice core code that has drifted into the host tree. Omitting src/** left
// the rank-1 invariant unenforced everywhere host code actually lands.
const HOST_TREE = 'src';
const files = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, HOST_TREE))];

for (const file of files) {
  const rel = relative(ROOT, file);
  const tree = rel.split('/')[0];
  const isHost = tree === HOST_TREE;
  const pkg = isHost ? HOST_TREE : rel.split('/')[1];
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  // Rule 4: NO NUL BYTES IN SOURCE.
  //
  // Not cosmetic. Four files in the prior lineage carried 1-3 literal NUL bytes
  // each, which makes grep classify them as binary and SUPPRESS matching lines;
  // `git grep` reports "Binary file ... matches" and no line number. A verified
  // claim about one of those files was nearly recorded as unverified in this
  // repo's own history because of it. An invisible character that silently
  // breaks the project's main search tool is a hazard for every future audit.
  // Built with fromCharCode rather than written as a literal or an escape: an
  // earlier revision of this very line was authored with a REAL NUL byte inside
  // the string, which made this file itself invisible to grep. Constructing the
  // character means no editor, tool or copy-paste can reintroduce one here.
  const nul = source.indexOf(String.fromCharCode(0));
  if (nul !== -1) {
    const line = source.slice(0, nul).split('\n').length;
    flag(file, line, 'nul-byte', 'literal NUL byte in source; grep will treat this file as binary');
  }

  lines.forEach((text, i) => {
    for (const [, spec] of text.matchAll(SPEC)) {
      const at = i + 1;

      // Rule 1 applies to core only. src/** is the host adapter and is allowed
      // to import vscode; that is its entire job.
      if (!isHost && (spec === 'vscode' || spec.startsWith('vscode/'))) {
        flag(file, at, 'cli-purity', `package "${pkg}" imports ${spec}; core must run under plain node`);
      }

      const deep = spec.match(/^(@cpg\/[^/]+)\/(.+)$/);
      if (deep) flag(file, at, 'deep-import', `reach past the front door of ${deep[1]} into "${deep[2]}"`);

      // The zero-deps rule is about what @cpg/model *ships*. Its own tests are
      // not shipped (tsconfig excludes them from the build), so they may import
      // a test runner. Rules 1 and 3 still apply to them.
      const isTest = /\.test\.[cm]?tsx?$/.test(file);
      const isRelative = spec.startsWith('.');
      if (pkg === 'model' && !isTest && !isRelative) {
        flag(file, at, 'model-zero-deps', `@cpg/model imports "${spec}"; it must have none`);
      }
    }
  });
}

// Built output is skipped above, which is how a stale dist/__probe_types.js
// carrying a real `require("vscode")` sat in packages/model undetected: tsc -b
// never deletes outputs whose source is gone. Scanning dist for the import
// (not the bare word: model's .d.ts mentions vscode in a doc comment) is
// cheaper than cleaning before every compile, which would cost incrementality.
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  const dist = join(ROOT, 'packages', pkg, 'dist');
  if (!existsSync(dist)) continue;
  for (const file of walkAll(dist)) {
    if (!/\.[cm]?js$/.test(file)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      for (const [, spec] of text.matchAll(SPEC)) {
        if (spec === 'vscode' || spec.startsWith('vscode/')) {
          flag(file, i + 1, 'cli-purity', `built output of "${pkg}" requires ${spec}; delete the stale dist`);
        }
      }
    });
  }
}

if (violations.length) {
  console.error(`check-deps: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('check-deps: ok');
