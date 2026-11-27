// Stop-list 192 (sprint 37; C-PARSE Q1, I10, I15): ParseServiceOptions.runtimeDir names the folder that
// web-tree-sitter's own runtime, `web-tree-sitter.wasm`, is read from, so an install without node_modules
// parses. Expected values: the option's doc comment, I10 and I15.
//
// web-tree-sitter keeps its first SUCCESSFUL init for the rest of the process, and a failed one leaves
// nothing behind. Vitest runs each test file in a process of its own, so the runtime is cold when this
// file starts. Every case that needs a failed init runs before the one case that lets init succeed,
// which is last. Add no case after it.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ParserRuntime } from './abi';
import type { GrammarSource, ParseService } from './contract';
import { BUILTIN_LANGUAGES, createLanguageRegistry } from './registry';
import { createParseService } from './service';

const RUNTIME = 'web-tree-sitter.wasm';
/** The runtime beside web-tree-sitter's module: what a missing runtimeDir would fall back to. */
const NODE_MODULES_RUNTIME = require.resolve(`web-tree-sitter/${RUNTIME}`);
const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
const source: GrammarSource = {
  describe: () => `test source ${WASM_DIR}`,
  async load(ref) {
    const origin = join(WASM_DIR, ref.wasmFile);
    return { ok: true, bytes: new Uint8Array(await readFile(origin)), origin };
  },
};

function wp(path: string): WorkspacePath {
  if (!isWorkspacePath(path)) throw new Error(`not a workspace path: ${path}`);
  return path;
}

let temp = '';
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'cpg-runtime-dir-'));
});
afterAll(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});
const services: ParseService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

function make(runtimeDir: string, runtime?: ParserRuntime): ParseService {
  const registry = createLanguageRegistry();
  for (const language of BUILTIN_LANGUAGES) registry.register(language);
  registry.freeze();
  const service = createParseService({
    registry,
    source,
    runtimeDir,
    ...(runtime === undefined ? {} : { runtime }),
  });
  services.push(service);
  return service;
}
/** A new folder under the temporary one. `wasm`: web-tree-sitter.wasm's text there, or 'real' for a copy of the real one. */
function folder(name: string, wasm?: string): string {
  const dir = join(temp, name);
  mkdirSync(dir, { recursive: true });
  if (wasm === 'real') copyFileSync(NODE_MODULES_RUNTIME, join(dir, RUNTIME));
  else if (wasm !== undefined) writeFileSync(join(dir, RUNTIME), wasm);
  return dir;
}
const unavailable = (message: string) => [{ code: 'runtime-unavailable', message }];

describe('ParseServiceOptions.runtimeDir (stop-list 192)', () => {
  it('is ignored when a runtime is given: that runtime is the one started', async () => {
    let started = 0;
    const runtime: ParserRuntime = {
      init: () => {
        started++;
        return Promise.reject(new Error('the stand-in runtime'));
      },
      abiBindings: () => ({ minCompatible: 13, languageVersion: 15 }),
    };
    const errors = await make(folder('ignored'), runtime).ensureReady(['python']);
    expect([started, errors]).toEqual([
      1,
      unavailable(expect.stringContaining('the stand-in runtime')),
    ]);
  });

  it('a relative or empty folder is refused, never resolved against the cwd (I10)', async () => {
    // The cwd holds a real runtime at the relative path, so resolving it there would load it.
    const cwd = folder('cwd');
    folder(join('cwd', 'rel'), 'real');
    const before = process.cwd();
    process.chdir(cwd);
    try {
      const relative = await make('rel').ensureReady(['python']);
      const empty = await make('').ensureReady(['python']);
      expect([relative, empty]).toEqual([
        unavailable(expect.stringContaining('must be an absolute path')),
        unavailable(expect.stringContaining('must be an absolute path')),
      ]);
    } finally {
      process.chdir(before);
    }
  });

  it('a folder without web-tree-sitter.wasm is runtime-unavailable, naming the file: node_modules is not tried', async () => {
    const empty = folder('empty');
    const errors = await make(empty).ensureReady(['python']);
    expect(errors).toEqual(unavailable(expect.stringContaining(join(empty, RUNTIME))));
    const parsed = await make(empty).parse({ key: wp('a.py'), text: 'x = 1\n' });
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: 'runtime-unavailable',
        key: 'a.py',
        message: expect.stringContaining(join(empty, RUNTIME)),
      },
    });
  });

  it('a web-tree-sitter.wasm there that is not wasm is runtime-unavailable, naming the file', async () => {
    const junk = folder('junk', 'not a wasm module');
    const errors = await make(junk).ensureReady(['python']);
    expect(errors).toEqual(unavailable(expect.stringContaining(join(junk, RUNTIME))));
  });

  // Last: the first init that succeeds holds for the rest of this process.
  it('the same service parses once the file is there: a failed init is not memoised (I15)', async () => {
    const later = folder('later');
    const service = make(later);
    expect(await service.ensureReady(['python'])).toEqual(
      unavailable(expect.stringContaining(join(later, RUNTIME))),
    );
    copyFileSync(NODE_MODULES_RUNTIME, join(later, RUNTIME));
    const parsed = await service.parse({ key: wp('a.py'), text: 'x = 1\n' });
    expect(parsed.ok && [parsed.handle.rootType, parsed.handle.hasError]).toEqual([
      'module',
      false,
    ]);
    if (parsed.ok) parsed.handle.release();
  });
});
