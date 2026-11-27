#!/usr/bin/env node
// REAL (U6a.3-3 part 2, BMO-43; controller decision 112, C-PARSE Q1): `bun run compile`'s last step.
// Copies the grammar .wasm files the extension's code tier loads into the extension's own install, so a
// VSIX finds them beside its build and never through node_modules. The extension names the same folder
// as the grammar locator's `explicit` rule (apps/vscode/src/extension.ts). Stop-list 192 (sprint 37): it
// copies web-tree-sitter's own runtime, `web-tree-sitter.wasm`, beside them, and the extension names the
// folder as the parse service's `runtimeDir` too.
//
// Usage: node tools/copy-grammars.mjs [--outdir <path>]

import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The package that ships the grammar .wasm files (C-PARSE pinned; @cpg/parse's registry names it). */
export const GRAMMAR_PACKAGE = '@vscode/tree-sitter-wasm';

/** The grammars copied: those a language with an extractor needs (decision 96: python only at U6a). */
export const GRAMMARS = ['tree-sitter-python.wasm'];

/**
 * The package that ships the parser runtime's own .wasm: the web-tree-sitter that @cpg/parse depends on,
 * whose JS loads it (the two halves must come from one build).
 */
export const RUNTIME_PACKAGE = 'web-tree-sitter';

/** web-tree-sitter's runtime .wasm, by the name its JS asks `locateFile` for. */
export const RUNTIME = 'web-tree-sitter.wasm';

/** Where `bun run compile` copies them, relative to the repository root (the extension's install). */
export const DEFAULT_OUTDIR = 'apps/vscode/dist/grammars';

/**
 * Copies each of GRAMMARS from `<GRAMMAR_PACKAGE's package.json directory>/wasm` (the package anchor,
 * resolved from this repository), then RUNTIME from the RUNTIME_PACKAGE that @cpg/parse resolves
 * (`createRequire(<@cpg/parse's package.json>).resolve('web-tree-sitter/web-tree-sitter.wasm')`), into
 * `outdir`, absolute or relative to the repository root (never the cwd), making it and its parents first.
 * Each copy is byte-identical; a file already there is replaced. Resolves to the absolute `outdir` and the
 * absolute paths written, in GRAMMARS order, then RUNTIME. Rejects when a package or a file cannot be read
 * or the folder cannot be written; the CLI then prints the error and exits 1.
 *
 * @param {{ outdir?: string }} [options]
 * @returns {Promise<{ outdir: string, files: string[] }>}
 */
// REAL
export async function copyGrammars({ outdir = DEFAULT_OUTDIR } = {}) {
  const packageJson = createRequire(import.meta.url).resolve(`${GRAMMAR_PACKAGE}/package.json`);
  const sourceDir = join(dirname(packageJson), 'wasm');
  const targetDir = resolve(ROOT, outdir);
  await mkdir(targetDir, { recursive: true });
  const files = await Promise.all(
    GRAMMARS.map(async (name) => {
      const dest = join(targetDir, name);
      await copyFile(join(sourceDir, name), dest);
      return dest;
    }),
  );
  return { outdir: targetDir, files };
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
