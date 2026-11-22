#!/usr/bin/env node
// `bun run clean`: full reset of everything generated (build output, caches, reports).
// A node script rather than `rm -rf` in package.json so it works on every OS.

import { readdirSync, rmSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const targets = [
  'out',
  'coverage',
  'reports',
  '.stryker-tmp',
  '.turbo',
  'node_modules/.cache/turbo',
  ...readdirSync(`${ROOT}/packages`, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `packages/${d.name}/dist`),
];

// Stray *.tsbuildinfo (e.g. from before tsBuildInfoFile moved inside the output dirs).
function findBuildInfo(dir, found = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name)) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) findBuildInfo(p, found);
    else if (e.name.endsWith('.tsbuildinfo')) found.push(p.slice(ROOT.length + 1));
  }
  return found;
}

for (const t of [...targets, ...findBuildInfo(ROOT)]) {
  rmSync(`${ROOT}/${t}`, { recursive: true, force: true });
  console.log(`removed ${t}`);
}
