#!/usr/bin/env node
// Runtime purity proof (U2c.3, BMO-48, CS-6 in docs/outline/05-contracts.yaml).
// Usage: node tools/purity-proof.mjs [--plant] [root]
//
// Proves under plain node that loading and running the built CLI bin (`cpg index --dry-run
// fixtures/ladder`) never requests `vscode`, the MCP SDK, or a DOM implementation, and introduces
// no DOM globals. Runs under plain node rather than vitest because vite-node bypasses
// `Module._load`, so a trap installed inside vitest observes nothing.
//
// With `--plant`, writes a temporary `require('vscode')` probe at
// `packages/engine/out/__purity_plant.js` and asserts the trap fires on it (anti-vacuity).
// `packages/engine/out` is chosen because it is git-ignored, skipped by check-deps, oxlint and
// oxfmt, and in no turbo `outputs`, so concurrent gates that scan `dist` never see the plant.

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VSCODE_RE = /^vscode(\/|$)/;
const FORBIDDEN_RE = [
  VSCODE_RE,
  /^@modelcontextprotocol\//,
  /^(?:jsdom|happy-dom|linkedom)(?:\/|$)/,
];
const ENV_KEYS = ['CPG_WORKSPACE', 'CPG_HOST', 'CPG_PORT', 'CPG_GRAPH'];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function firstLine(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0];
}

function relPath(p, root) {
  return p === null ? '<unknown>' : relative(root, p).split(sep).join('/');
}

function classify(record, root) {
  const { request, resolved } = record;
  if (resolved === null) {
    return { owner: `${request} (not found)`, key: `unresolved:${request}` };
  }
  if (!isAbsolute(resolved)) {
    const name = resolved.startsWith('node:') ? resolved.slice(5) : resolved;
    const mod = `node:${name}`;
    return { owner: mod, key: mod };
  }
  const posix = resolved.split(sep).join('/');
  const marker = '/node_modules/';
  const idx = posix.lastIndexOf(marker);
  if (idx !== -1) {
    const parts = posix.slice(idx + marker.length).split('/');
    const pkg =
      parts[0].startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    return { owner: pkg, key: posix };
  }
  const rel = relative(root, resolved).split(sep).join('/');
  return { owner: rel.split('/').slice(0, 2).join('/'), key: posix };
}

function main() {
  const args = process.argv.slice(2);
  const plant = args.includes('--plant');
  const rootArg = args.find((a) => !a.startsWith('-'));
  const ROOT = realpathSync(resolve(rootArg ?? REPO_ROOT));
  const BIN = join(ROOT, 'apps/cli/dist/main.js');
  const ENGINE_DIST = join(ROOT, 'packages/engine/dist');
  const FIXTURE = join(ROOT, 'fixtures/ladder');
  const PLANT = join(ROOT, 'packages/engine/out/__purity_plant.js');

  const records = [];
  /* oxlint-disable no-underscore-dangle -- Node's own name: Module._load and _resolveFilename are the trap surface */
  const original = Module._load;
  if (typeof original !== 'function') {
    console.error(
      'purity-proof: cannot install the Module._load trap: Module._load is not a function',
    );
    process.exitCode = 1;
    return;
  }

  function trap(request, parent, isMain, ...rest) {
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      // Unresolved requests (e.g. vscode) must still be recorded before delegating.
    }
    records.push({ request, parent: parent?.filename ?? null, resolved });
    return Reflect.apply(original, this, [request, parent, isMain, ...rest]);
  }

  try {
    Module._load = trap;
  } catch (err) {
    console.error(`purity-proof: cannot install the Module._load trap: ${firstLine(err)}`);
    process.exitCode = 1;
    return;
  }
  if (Module._load !== trap) {
    console.error(
      'purity-proof: cannot install the Module._load trap: Module._load did not retain the trap',
    );
    process.exitCode = 1;
    return;
  }
  /* oxlint-enable no-underscore-dangle */

  if (!existsSync(BIN)) {
    console.error('purity-proof: apps/cli/dist/main.js is not built (bun run typecheck builds it)');
    process.exitCode = 1;
    return;
  }

  for (const key of ENV_KEYS) delete process.env[key];
  process.argv = [process.execPath, BIN, 'index', '--dry-run', FIXTURE];

  const req = createRequire(import.meta.url);
  const problems = [];
  try {
    req(BIN);
  } catch (err) {
    problems.push(`the bin threw while loading: ${firstLine(err)}`);
  }

  if (plant) {
    const plantDir = dirname(PLANT);
    const made = !existsSync(plantDir);
    mkdirSync(plantDir, { recursive: true });
    try {
      writeFileSync(PLANT, "require('vscode');\n");
      req(PLANT);
    } catch {
      // Expected: vscode is not installed, or the package is native ESM where require is undefined.
    } finally {
      rmSync(PLANT, { force: true });
      if (made) rmSync(plantDir, { recursive: true, force: true });
    }
  }

  function verdict() {
    if (process.exitCode !== 0) {
      problems.push(
        process.exitCode === undefined
          ? 'cpg index --dry-run fixtures/ladder exited without an exit code'
          : `cpg index --dry-run fixtures/ladder exited ${String(process.exitCode)}`,
      );
    }

    const enginePrefix = `${ENGINE_DIST}${sep}`;
    // The proof requires the plant itself, so the plant's load never counts as the engine's.
    const sawEngine = records.some((r) => r.parent?.startsWith(enginePrefix));
    if (!sawEngine) {
      problems.push(
        'the trap saw no require issued from packages/engine/dist: the engine did not load through Module._load (native ESM?), so this run proves nothing',
      );
    }

    for (const r of records) {
      if (r.parent === PLANT) continue;
      if (FORBIDDEN_RE.some((re) => re.test(r.request))) {
        problems.push(`"${r.request}" requested by ${relPath(r.parent, ROOT)}`);
      }
    }

    if ('window' in globalThis || 'document' in globalThis) {
      problems.push('a DOM global (window or document) appeared during the run');
    }

    if (plant) {
      const fired = records.some((r) => r.parent === PLANT && VSCODE_RE.test(r.request));
      if (!fired) {
        problems.push(
          'the trap did not fire on the vscode import planted in packages/engine/out/__purity_plant.js, so a real one would go unseen',
        );
      }
    }

    const byOwner = new Map();
    const allModules = new Set();
    for (const r of records) {
      const { owner, key } = classify(r, ROOT);
      allModules.add(key);
      let files = byOwner.get(owner);
      if (!files) {
        files = new Set();
        byOwner.set(owner, files);
      }
      files.add(key);
    }

    console.log(
      `purity-proof: Module._load saw ${String(records.length)} requests for ${String(allModules.size)} modules during cpg index --dry-run fixtures/ladder`,
    );
    for (const [owner, files] of [...byOwner.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.log(`  ${owner} (${String(files.size)})`);
    }

    if (problems.length > 0) {
      for (const p of problems) console.error(`purity-proof: ${p}`);
      console.error(`purity-proof: FAIL (${String(problems.length)} problem(s))`);
      process.exitCode = 1;
      return;
    }

    if (plant) {
      console.log(
        'purity-proof: ok: the trap fired on the planted import ("vscode" requested by packages/engine/out/__purity_plant.js)',
      );
    } else {
      console.log('purity-proof: ok: no vscode, DOM or MCP SDK module was requested');
    }
    process.exitCode = 0;
  }

  process.once('beforeExit', verdict);
}

main();
