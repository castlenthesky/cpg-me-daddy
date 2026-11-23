#!/usr/bin/env node
// SEAT (U2b.1 part 2b, BMO-35): port of 21754b4:esbuild.js. Bundles the inspector page
// (apps/inspector/src/graph-page.ts) into one IIFE for the browser (owner decision 7a).
//
// Usage: node tools/build-inspector.mjs [--production] [--outfile <path>]

/** Where `bun run build:inspector` writes the bundle, relative to the repository root. */
export const DEFAULT_OUTFILE = 'apps/inspector/dist/page/graph.js';

/**
 * Bundles the page into `outfile` (absolute, or relative to the repository root): iife, browser,
 * es2022; minified with no sourcemap when `production`, else a sourcemap beside it. `@cpg/model`
 * resolves from source through apps/inspector/tsconfig.page.json. Resolves to the repo-relative
 * input paths and the warning count.
 *
 * @param {{ outfile?: string, production?: boolean }} [_options]
 * @returns {Promise<{ inputs: string[], warnings: number }>}
 */
export async function buildInspectorPage(_options = {}) {
  throw new Error('SEAT: buildInspectorPage is U2b.1 part 2b');
}
