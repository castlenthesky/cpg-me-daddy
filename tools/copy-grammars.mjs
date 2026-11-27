#!/usr/bin/env node
// SEAT (U6a.3-3 part 2, BMO-43; controller decision 112, C-PARSE Q1): `bun run compile`'s last step.
// Copies the grammar .wasm files the extension's code tier loads into the extension's own install, so a
// VSIX finds them beside its build and never through node_modules. The extension names the same folder
// as the grammar locator's `explicit` rule (apps/vscode/src/extension.ts).
//
// Usage: node tools/copy-grammars.mjs [--outdir <path>]

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The package that ships the grammar .wasm files (C-PARSE pinned; @cpg/parse's registry names it). */
export const GRAMMAR_PACKAGE = '@vscode/tree-sitter-wasm';

/** The grammars copied: those a language with an extractor needs (decision 96: python only at U6a). */
export const GRAMMARS = ['tree-sitter-python.wasm'];

/** Where `bun run compile` copies them, relative to the repository root (the extension's install). */
export const DEFAULT_OUTDIR = 'apps/vscode/dist/grammars';

/**
 * Copies each of GRAMMARS from `<GRAMMAR_PACKAGE's package.json directory>/wasm` (the package anchor,
 * resolved from this repository) into `outdir`, absolute or relative to the repository root (never the
 * cwd), making it and its parents first. Each copy is byte-identical; a file already there is replaced.
 * Resolves to the absolute `outdir` and the absolute paths written, in GRAMMARS order. Rejects when the
 * package or a grammar cannot be read or the folder cannot be written; the CLI then prints the error and
 * exits 1.
 *
 * @param {{ outdir?: string }} [options]
 * @returns {Promise<{ outdir: string, files: string[] }>}
 */
// SEAT (decision 112)
export async function copyGrammars({ outdir = DEFAULT_OUTDIR } = {}) {
  throw new Error(`SEAT: copyGrammars(${outdir}) is decision 112`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { outdir: { type: 'string' } },
  });

  copyGrammars(values.outdir !== undefined ? { outdir: values.outdir } : {}).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
