#!/usr/bin/env node
// REAL (U2b.1 part 2b, BMO-35): port of 21754b4:esbuild.js. Bundles the inspector page
// (apps/inspector/src/graph-page.ts) into one IIFE for the browser (owner decision 7a).
//
// Usage: node tools/build-inspector.mjs [--production] [--outfile <path>]

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Where `bun run build:inspector` writes the bundle, relative to the repository root. */
export const DEFAULT_OUTFILE = 'apps/inspector/dist/page/graph.js';

/**
 * Bundles the page into `outfile` (absolute, or relative to the repository root): iife, browser,
 * es2022; minified with no sourcemap when `production`, else a sourcemap beside it. `@cpg/model`
 * resolves from source through apps/inspector/tsconfig.page.json. Resolves to the repo-relative
 * input paths and the warning count.
 *
 * @param {{ outfile?: string, production?: boolean }} [options]
 * @returns {Promise<{ inputs: string[], warnings: number }>}
 */
export async function buildInspectorPage({ outfile = DEFAULT_OUTFILE, production = false } = {}) {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['apps/inspector/src/graph-page.ts'],
    tsconfig: 'apps/inspector/tsconfig.page.json',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: resolve(ROOT, outfile),
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
    metafile: true,
  });

  return {
    inputs: Object.keys(result.metafile.inputs),
    warnings: result.warnings.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      production: { type: 'boolean', default: false },
      outfile: { type: 'string' },
    },
  });

  buildInspectorPage({
    production: values.production,
    ...(values.outfile !== undefined ? { outfile: values.outfile } : {}),
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
