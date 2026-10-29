#!/usr/bin/env node
// Dependency-direction gate. Usage: node tools/check-deps.mjs [root]
//
// The repository has two tiers (DQ-08): packages/** is core — host-free,
// portable, runs under plain node, no composition roots — and apps/* are front
// doors, each owning one composition root and one host SDK. Every rule below
// is a lesson rather than a preference, and every rule has been seen to fail
// on a planted violation (tools/check-deps.test.mjs; L-31).
//
//  1. HOST-SDK (rank-1 constraint). Nothing under packages/** may import a host
//     SDK (vscode, the MCP SDK) or touch a DOM global. The core has to run
//     under plain node, so a host import anywhere in it is a build failure,
//     not a review comment.
//
//  2. APP-TIER. Each apps/<name> may import only relative paths, node
//     builtins, @cpg/* front doors, and ITS OWN host SDK. The allowlist lives
//     here, not in the app's manifest: an exemption an app can grant itself is
//     how the invariant dies (DQ-08 rejected option c).
//
//  3. NO DEEP IMPORTS across packages. `@cpg/x/dist/contract` is how the graph
//     vocabulary ended up owned by the renderer package, with four consumers
//     reaching past its front door and a fifth violating the rule silently.
//
//  4. @cpg/model IMPORTS NOTHING. It is required from both a CommonJS host and
//     a browser/ESM webview; anything it pulls in gets pulled into whichever
//     side merely wanted the types.
//
//  5. COMPOSITION ROOTS LIVE IN apps/*. A core file that wires two or more
//     sibling packages together (other than the shared vocabulary) is a
//     composition root in disguise. packages/engine is the one package
//     allowed to know more than one sibling (L-26, L-28).
//
//  6. NO NUL BYTES IN SOURCE (see the comment at the check).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve } from 'node:path';

const ROOT = process.argv[2]
  ? resolve(process.argv[2])
  : new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP = new Set(['node_modules', 'dist', 'out', '.git', '.vscode-test', '.debate']);
// `from '…'`, `require('…')`, `import('…')`, and the side-effect form `import '…'`.
const SPEC = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const DOM_GLOBAL = /\b(?:window|document|navigator)\s*\.|\b(?:HTMLElement|customElements)\b/;

const HOST_SDKS = ['vscode', '@modelcontextprotocol/'];
const APP_SDKS = {
  vscode: ['vscode'],
  mcp: ['@modelcontextprotocol/'],
  cli: [],
  inspector: [],
};

// 'x/' matches any subpath of a scope; 'x' matches x itself and x/anything.
function matches(spec, entry) {
  return entry.endsWith('/') ? spec.startsWith(entry) : spec === entry || spec.startsWith(entry + '/');
}
const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0]);

function walk(dir, skip, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, skip, acc);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(full)) acc.push(full);
  }
  return acc;
}

const violations = [];
function flag(file, line, rule, detail) {
  violations.push(`${relative(ROOT, file)}:${line}  [${rule}] ${detail}`);
}

const files = [...walk(join(ROOT, 'packages'), SKIP), ...walk(join(ROOT, 'apps'), SKIP)];

for (const file of files) {
  const [tier, pkg] = relative(ROOT, file).split('/');
  const isApp = tier === 'apps';
  const isTest = /\.test\.[cm]?[jt]sx?$/.test(file);
  const source = readFileSync(file, 'utf8');
  const siblings = new Set();

  // Rule 6: NO NUL BYTES IN SOURCE.
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

  source.split('\n').forEach((text, i) => {
    const at = i + 1;
    const code = text.trimStart();
    const isComment = code.startsWith('//') || code.startsWith('*') || code.startsWith('/*');

    if (!isApp && !isComment && DOM_GLOBAL.test(text)) {
      flag(file, at, 'host-sdk', `package "${pkg}" touches a DOM global; core must run under plain node`);
    }

    for (const [, spec] of text.matchAll(SPEC)) {
      const cpg = spec.match(/^@cpg\/([^/]+)(\/.+)?$/);
      if (cpg?.[2]) flag(file, at, 'deep-import', `reach past the front door of @cpg/${cpg[1]} into "${cpg[2].slice(1)}"`);
      if (cpg && cpg[1] !== 'model' && cpg[1] !== pkg) siblings.add(cpg[1]);

      if (isApp) {
        const allowed =
          spec.startsWith('.') ||
          isBuiltin(spec) ||
          cpg ||
          (isTest && spec === 'vitest') ||
          (APP_SDKS[pkg] ?? []).some((entry) => matches(spec, entry));
        if (!allowed) flag(file, at, 'app-tier', `app "${pkg}" imports "${spec}"; only builtins, @cpg/* and its own host SDK`);
        continue;
      }

      if (HOST_SDKS.some((entry) => matches(spec, entry))) {
        flag(file, at, 'host-sdk', `package "${pkg}" imports ${spec}; core must run under plain node`);
      }
      // The zero-deps rule is about what @cpg/model *ships*. Its own tests are
      // not shipped (tsconfig excludes them from the build), so they may import
      // a test runner.
      if (pkg === 'model' && !isTest && !spec.startsWith('.')) {
        flag(file, at, 'model-zero-deps', `@cpg/model imports "${spec}"; it must have none`);
      }
    }
  });

  if (!isApp && pkg !== 'engine' && siblings.size >= 2) {
    flag(file, 1, 'composition-root', `wires ${[...siblings].map((s) => '@cpg/' + s).join(' + ')}; only packages/engine may know more than one sibling`);
  }
}

// Built output is skipped above, which is how a stale dist/__probe_types.js
// carrying a real `require("vscode")` sat in packages/model undetected: tsc -b
// never deletes outputs whose source is gone. Scanning dist for the import
// (not the bare word: model's .d.ts mentions vscode in a doc comment) is
// cheaper than cleaning before every compile, which would cost incrementality.
const pkgsDir = join(ROOT, 'packages');
for (const pkg of existsSync(pkgsDir) ? readdirSync(pkgsDir) : []) {
  for (const file of walk(join(pkgsDir, pkg, 'dist'), new Set())) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      for (const [, spec] of text.matchAll(SPEC)) {
        if (HOST_SDKS.some((entry) => matches(spec, entry))) {
          flag(file, i + 1, 'host-sdk', `built output of "${pkg}" requires ${spec}; delete the stale dist`);
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
