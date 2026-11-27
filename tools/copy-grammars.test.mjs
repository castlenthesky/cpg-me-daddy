// U6a.3-3 part 2 (BMO-43; controller decision 112, C-PARSE Q1): tools/copy-grammars.mjs, the last step of
// `bun run compile`. It copies the python grammar from the grammar package into the extension's install,
// where the extension tells the engine to look. Expected values: decision 112 and the copy's doc comment.
// The default folder is checked by build-inspector.test.mjs ("F5's build task"), which runs compile's
// steps for real; this file never writes there, so the two never race on one file.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyGrammars, DEFAULT_OUTDIR, GRAMMAR_PACKAGE, GRAMMARS } from './copy-grammars.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'tools', 'copy-grammars.mjs');
const PACKAGE_JSON = createRequire(import.meta.url).resolve(
  '@vscode/tree-sitter-wasm/package.json',
);
const PYTHON = readFileSync(join(dirname(PACKAGE_JSON), 'wasm', 'tree-sitter-python.wasm'));
// Inside the repository (dist is git-ignored), so a cwd-relative resolution lands somewhere else.
const RELATIVE = `apps/vscode/dist/copy-grammars-test-${String(process.pid)}`;
const RELATIVE_CALL = `${RELATIVE}-call`;

let dir = '';
let elsewhere = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'copy-grammars-'));
  elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  rmSync(join(REPO, RELATIVE), { recursive: true, force: true });
  rmSync(join(REPO, RELATIVE_CALL), { recursive: true, force: true });
});

const runCli = (args, cwd) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const sameAsPackage = (file) => readFileSync(file).equals(PYTHON);

describe('copyGrammars', () => {
  it("copies the python grammar of @vscode/tree-sitter-wasm, for the extension's apps/vscode/dist/grammars", () => {
    expect([GRAMMAR_PACKAGE, GRAMMARS, DEFAULT_OUTDIR]).toEqual([
      '@vscode/tree-sitter-wasm',
      ['tree-sitter-python.wasm'],
      'apps/vscode/dist/grammars',
    ]);
  });

  it('copies each grammar byte for byte into a folder it makes, parents included', async () => {
    const outdir = join(dir, 'made', 'here', 'grammars');
    const file = join(outdir, 'tree-sitter-python.wasm');
    expect(await copyGrammars({ outdir })).toEqual({ outdir, files: [file] });
    expect([readdirSync(outdir), sameAsPackage(file)]).toEqual([['tree-sitter-python.wasm'], true]);
  });

  it('replaces a copy that is already there', async () => {
    const outdir = join(dir, 'stale');
    mkdirSync(outdir);
    writeFileSync(join(outdir, 'tree-sitter-python.wasm'), 'not a grammar');
    await copyGrammars({ outdir });
    expect(sameAsPackage(join(outdir, 'tree-sitter-python.wasm'))).toBe(true);
  });

  // Round two (review 9): the function itself resolves, from any cwd, and answers absolute paths.
  it('takes a relative outdir against the repository root, not the cwd', async () => {
    const cwd = process.cwd();
    const outdir = join(REPO, RELATIVE_CALL);
    process.chdir(elsewhere);
    try {
      expect(await copyGrammars({ outdir: RELATIVE_CALL })).toEqual({
        outdir,
        files: [join(outdir, 'tree-sitter-python.wasm')],
      });
    } finally {
      process.chdir(cwd);
    }
    expect([
      sameAsPackage(join(outdir, 'tree-sitter-python.wasm')),
      existsSync(join(elsewhere, RELATIVE_CALL)),
    ]).toEqual([true, false]);
  });

  // Post-implementation (sabotage): the folder is made, but the grammar cannot be written into it.
  it('rejects when a grammar cannot be written', async () => {
    const outdir = join(dir, 'occupied');
    mkdirSync(join(outdir, 'tree-sitter-python.wasm'), { recursive: true });
    await expect(copyGrammars({ outdir })).rejects.toThrow('tree-sitter-python.wasm');
  });

  it('rejects when the folder cannot be made', async () => {
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, '');
    await expect(copyGrammars({ outdir: join(blocker, 'grammars') })).rejects.toThrow(blocker);
  });
});

describe('node tools/copy-grammars.mjs', () => {
  it('takes --outdir relative to the repository root, not the cwd', () => {
    const r = runCli(['--outdir', RELATIVE], elsewhere);
    expect(r).toMatchObject({ status: 0 });
    expect(sameAsPackage(join(REPO, RELATIVE, 'tree-sitter-python.wasm'))).toBe(true);
    expect(existsSync(join(elsewhere, RELATIVE))).toBe(false);
  });

  it('exits 1, saying why, when it cannot write', () => {
    const blocker = join(dir, 'another-file');
    writeFileSync(blocker, '');
    const r = runCli(['--outdir', join(blocker, 'grammars')], REPO);
    expect([r.status, r.out.includes(blocker)]).toEqual([1, true]);
  });
});
