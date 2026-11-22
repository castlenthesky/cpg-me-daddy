// Every [parse] line in fixtures/ladder, run through the real wasm parser. The lines were written by
// hand from the source, so this checks the parser against an answer it did not produce.
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isWorkspacePath } from '@cpg/model';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_LANGUAGES, createLanguageRegistry } from './registry';
import { createParseService } from './service';

const LADDER = join(__dirname, '../../../fixtures/ladder');
const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');

const registry = createLanguageRegistry();
for (const r of BUILTIN_LANGUAGES) registry.register(r);
registry.freeze();
const service = createParseService({
  registry,
  source: {
    describe: () => WASM_DIR,
    load: async (ref) => ({
      ok: true,
      bytes: new Uint8Array(await readFile(join(WASM_DIR, ref.wasmFile))),
      origin: ref.wasmFile,
    }),
  },
});
afterAll(() => service.dispose());

const lines = readdirSync(LADDER)
  .filter((rung) => /^\d\d-/.test(rung))
  .flatMap((rung) => {
    const text = readFileSync(join(LADDER, rung, 'expected.cpg'), 'utf8');
    const section = /\[parse\]\n([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? '';
    return section
      .split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
      .filter((l) => l !== '')
      .map((l) => ({ rung, words: l.split(/\s+/) }));
  });

describe('fixtures/ladder [parse]', () => {
  it('has lines to check', () => {
    expect(lines.length).toBeGreaterThanOrEqual(17);
  });

  it.each(lines.map((l) => [`${l.rung} ${l.words.join(' ')}`, l] as const))(
    '%s',
    async (_name, { rung, words }) => {
      const path = words[1] ?? '';
      if (!isWorkspacePath(path)) throw new Error(`${rung}: ${path} is not a workspace path`);
      const text = readFileSync(join(LADDER, rung, 'ws', path), 'utf8');
      const outcome = await service.parse({ key: path, text });
      if (!outcome.ok && outcome.error.code !== 'unsupported-language')
        throw new Error(outcome.error.message);
      const actual = outcome.ok
        ? [
            'PARSE',
            path,
            `language=${outcome.handle.language}`,
            `root=${outcome.handle.rootType}`,
            `hasError=${String(outcome.handle.hasError)}`,
          ]
        : ['SKIP', path];
      if (outcome.ok) outcome.handle.release();
      expect(actual).toEqual(words);
    },
  );
});
