// Exit-code and read-only contract of tools/schema-doc.mjs (design D12/D13, SD-8), run on temp copies via --file.
// The region content itself is covered by packages/model/src/schema/doc.test.ts; the real-file gate is prove-gates.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'schema-doc.mjs');
const dir = mkdtempSync(join(tmpdir(), 'schema-doc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STALE = '# BEGIN GENERATED (x)\nstale: true\n# END GENERATED\nrest: 1\n';
let n = 0;
function run(content, ...args) {
  const file = join(dir, `f${n++}.yaml`);
  if (content !== undefined) writeFileSync(file, content);
  const res = spawnSync(process.execPath, [SCRIPT, ...args, '--file', file], { encoding: 'utf8' });
  return { status: res.status, out: res.stdout + res.stderr, file };
}
const TIMEOUT = 180_000;

// The script builds packages/model before rendering. Warm that build once, serially, so the
// per-case spawns below only find an up-to-date dist (no overlapping tsc -b on dist/.tsbuildinfo).
beforeAll(() => {
  run(STALE, '--check');
}, TIMEOUT);

describe('tools/schema-doc.mjs', () => {
  it(
    '--check exits 1 on a stale region, names the fix, and never writes (SD-8)',
    () => {
      const r = run(STALE, '--check');
      expect(r.status).toBe(1);
      expect(r.out).toMatch(
        /generated region is stale \(first difference at line \d+\); run `bun run schema:doc`/,
      );
      expect(readFileSync(r.file, 'utf8')).toBe(STALE);
    },
    TIMEOUT,
  );

  it(
    '--check treats CRLF line endings inside the region as drift (D11)',
    () => {
      const r = run(STALE.replaceAll('\n', '\r\n'), '--check');
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/generated region is stale/);
    },
    TIMEOUT,
  );

  it(
    'write mode regenerates, preserves the outside bytes, and a following --check exits 0',
    () => {
      const w = run(STALE);
      expect(w.status).toBe(0);
      expect(w.out).toContain('regenerated');
      const written = readFileSync(w.file, 'utf8');
      expect(written.startsWith('# BEGIN GENERATED (x)\n')).toBe(true);
      expect(written.endsWith('# END GENERATED\nrest: 1\n')).toBe(true);
      expect(written).toContain('nodes:');
      expect(written).not.toContain('stale: true');
      const c = spawnSync(process.execPath, [SCRIPT, '--check', '--file', w.file], {
        encoding: 'utf8',
      });
      expect(c.status).toBe(0);
      const again = spawnSync(process.execPath, [SCRIPT, '--file', w.file], { encoding: 'utf8' });
      expect(again.status).toBe(0);
      expect(again.stdout + again.stderr).toContain('is up to date');
      expect(readFileSync(w.file, 'utf8')).toBe(written);
    },
    TIMEOUT,
  );

  it(
    'exits 1 with the marker error on a file without markers, in both modes',
    () => {
      for (const args of [[], ['--check']]) {
        const r = run('no markers here\n', ...args);
        expect(r.status).toBe(1);
        expect(r.out).toContain(
          'expected exactly one line starting with "# BEGIN GENERATED", found 0',
        );
        expect(readFileSync(r.file, 'utf8')).toBe('no markers here\n');
      }
    },
    TIMEOUT,
  );

  it(
    'exits 1 with "cannot read" when the file is missing',
    () => {
      const r = run(undefined, '--check');
      expect(r.status).toBe(1);
      expect(r.out).toContain('schema-doc: cannot read');
    },
    TIMEOUT,
  );

  it(
    'exits 2 and prints usage on an unknown argument',
    () => {
      const r = run(STALE, '--bogus');
      expect(r.status).toBe(2);
      expect(r.out).toContain('usage: node tools/schema-doc.mjs [--check] [--file <path>]');
      expect(readFileSync(r.file, 'utf8')).toBe(STALE);
    },
    TIMEOUT,
  );
});
