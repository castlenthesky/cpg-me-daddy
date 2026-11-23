// BMO-38: "the loader produces one CpgConfigInput handed to the engine; the engine reads no env
// itself" (and 03-architecture §9: "the engine never reads the environment itself"). A guard: no
// shipped engine source names process.env, process.argv or the node:process module.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const AMBIENT =
  /\bprocess\s*(?:\?\.|\.|\[\s*['"`])\s*(?:env|argv|cwd)\b|\}\s*=\s*process\b|['"`](?:node:)?process['"`]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return sources(path);
    return d.name.endsWith('.ts') && !/\.test(-d)?\.ts$/.test(d.name) ? [path] : [];
  });
}

describe('the engine reads no env itself', () => {
  it('no shipped engine source reads process.env, argv, cwd, or node:process', () => {
    const files = sources(SRC).map((f) => relative(SRC, f));
    // Not vacuous: the scan sees the engine, the walker and the config resolver.
    expect(files).toEqual(
      expect.arrayContaining([
        'engine.ts',
        join('walker', 'walker.ts'),
        join('config', 'resolve.ts'),
      ]),
    );
    const offenders = files.filter((f) => AMBIENT.test(readFileSync(join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it.each([
    'const h = process.env.CPG_HOST;',
    "const h = process.env['CPG_HOST'];",
    "const a = process['argv'];",
    "import { env } from 'node:process';",
    "const { env } = require('process');",
    'const h = process?.env?.CPG_HOST;',
    'const { env } = process;',
    'const { argv, env: e } = process;',
    'const here = process.cwd();',
  ])('the pattern catches %s (the guard can fail)', (line) => {
    expect(AMBIENT.test(line)).toBe(true);
  });
});
