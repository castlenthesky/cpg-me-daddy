// `cpg schema`, from BMO-81 ("prints CPG_SCHEMA as a cpg.schema document; --check runs the drift
// check against docs/outline/04-schema.yaml") and C-CLI: the document is Document<'cpg.schema', …>
// (v, kind, tool from the manifest, producedAt from io.now), stdout never depends on isTty (I-9), a
// malformed flag is exit 2 before the engine (I-12), and no disk side effect is on by default (I-19).
// 03-architecture §10: exit 1 is "operation failed", 2 a usage error; 3 is verify/doctor only.
// The doc fixtures wrap the already-tested renderSchemaRegion; line numbers are found in the text.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createEngine, type CpgEngine } from '@cpg/engine';
import {
  CPG_SCHEMA,
  GENERATED_BEGIN,
  GENERATED_END,
  renderSchemaRegion,
  type SchemaDocInput,
} from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import { captureIo } from './io';
import { EXIT, run } from './run';

const manifest = { bin: 'cpg', version: '9.8.7' };
const DOC = join('docs', 'outline', '04-schema.yaml');
const SMALL: SchemaDocInput = { version: 99, nodes: [], edges: [] };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const realEngine = (): CpgEngine => createEngine({ version: manifest.version }, { sinks: [] });

function fakeEngine(schema: SchemaDocInput) {
  let calls = 0;
  const engine: CpgEngine = {
    identity: { name: 'fake', version: '0', languages: [] },
    connect: () => Promise.reject(new Error('cpg schema never connects')),
    index: () => Promise.reject(new Error('cpg schema never indexes')),
    verify: () => Promise.reject(new Error('cpg schema never verifies')),
    schema: () => {
      calls++;
      return schema;
    },
  };
  return { engine, calls: () => calls };
}

async function cli(
  argv: string[],
  engine: CpgEngine | undefined,
  o: { isTty?: boolean; env?: Record<string, string>; cwd?: string } = {},
) {
  const io = captureIo({ isTty: o.isTty ?? false, ...(o.env && { env: o.env }) });
  const code = await run(argv, io, {
    manifest,
    ...(engine && { engine }),
    ...(o.cwd !== undefined && { cwd: o.cwd }),
  });
  return { code, stdout: io.stdout, stderr: io.stderr.join('\n') };
}

/** The text of a 04-schema.yaml whose generated region is `schema`'s, with hand-owned lines around it. */
const docFor = (schema: SchemaDocInput): string =>
  `top: 1\n${GENERATED_BEGIN} (fixture)\n${renderSchemaRegion(schema)}${GENERATED_END}\ntail: 2\n`;

/** A temp workspace; `text` (if given) is written to its docs/outline/04-schema.yaml. */
async function workspace(text?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-cli-schema-'));
  roots.push(root);
  if (text !== undefined) {
    await mkdir(join(root, 'docs', 'outline'), { recursive: true });
    await writeFile(join(root, DOC), text);
  }
  return root;
}

const lineOf = (text: string, line: string): number => {
  const at = text.split('\n').indexOf(line);
  if (at === -1) throw new Error(`fixture has no line ${line}`);
  return at + 1;
};

/** The C-CLI Document for `body`: tool from the manifest, producedAt from captureIo's now() of 0. */
const document = (body: unknown) => ({
  v: 1,
  kind: 'cpg.schema',
  tool: 'cpg@9.8.7',
  producedAt: '1970-01-01T00:00:00.000Z',
  body,
});

const check = async (argv: string[], o: { env?: Record<string, string>; cwd?: string }) =>
  (await cli(['schema', '--check', ...argv], realEngine(), o)).code;

describe('cpg schema --print: one cpg.schema document', () => {
  it('prints CPG_SCHEMA, whole, as exactly one JSON line; nothing on stderr; exit 0', async () => {
    const r = await cli(['schema', '--print'], realEngine());
    expect(r.code).toBe(EXIT.OK);
    expect(r.stderr).toBe('');
    expect(r.stdout).toHaveLength(1);
    const parsed: unknown = JSON.parse(r.stdout[0] ?? '');
    expect(parsed).toEqual(document(JSON.parse(JSON.stringify(CPG_SCHEMA))));
  });

  it("the body is engine.schema(), read through the port (not the CLI's own copy)", async () => {
    const f = fakeEngine(SMALL);
    const r = await cli(['schema', '--print'], f.engine);
    const parsed: unknown = JSON.parse(r.stdout[0] ?? '');
    expect(parsed).toEqual(document(SMALL));
    expect(f.calls()).toBe(1);
  });

  it('--format json and --format=json change nothing; isTty changes nothing (I-9)', async () => {
    const base = await cli(['schema', '--print'], realEngine());
    for (const argv of [
      ['schema', '--print', '--format', 'json'],
      ['schema', '--format=json', '--print'],
    ])
      expect(await cli(argv, realEngine())).toEqual(base);
    expect(await cli(['schema', '--print'], realEngine(), { isTty: true })).toEqual(base);
  });
});

describe('cpg schema: exactly one mode', () => {
  it.each([
    [['schema']],
    [['schema', '--print', '--check']],
    [['schema', '--format', 'json']],
    [['schema', '--workspace', '/w']],
  ])(
    '%j is a usage error naming both modes: exit 2, stdout empty, engine untouched',
    async (argv) => {
      for (const withEngine of [true, false]) {
        const f = fakeEngine(SMALL);
        const r = await cli(argv, withEngine ? f.engine : undefined);
        expect(r.code).toBe(EXIT.USAGE);
        expect(r.stdout).toEqual([]);
        expect(r.stderr).toMatch(/^cpg: /);
        expect(r.stderr).toContain('--print');
        expect(r.stderr).toContain('--check');
        expect(r.stderr).not.toContain('not built yet');
        expect(r.stderr).toContain("run 'cpg schema --help'");
        expect(f.calls()).toBe(0);
      }
    },
  );

  it('--check with no engine is still a SEAT: exit 2 "not built yet"', async () => {
    const root = await workspace(docFor(CPG_SCHEMA));
    const r = await cli(['schema', '--check', '--workspace', root], undefined);
    expect(r).toEqual({ code: EXIT.USAGE, stdout: [], stderr: "cpg: 'schema' is not built yet" });
  });
});

describe('cpg schema --check: drift of docs/outline/04-schema.yaml', () => {
  it('an up-to-date doc exits 0, stdout empty, stderr says up to date and names the file', async () => {
    const root = await workspace(docFor(CPG_SCHEMA));
    const r = await cli(['schema', '--check', '--workspace', root], realEngine());
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toEqual([]);
    expect(r.stderr).toContain('up to date');
    expect(r.stderr).toContain(join(root, DOC));
  });

  it('a hand edit outside the generated region is not drift: exit 0', async () => {
    const root = await workspace(docFor(CPG_SCHEMA).replace('tail: 2', 'tail: hand-edited'));
    const r = await cli(['schema', '--check', '--workspace', root], realEngine());
    expect(r.code).toBe(EXIT.OK);
  });

  it('a hand edit inside the region exits 1 naming the first differing line; the file is not written', async () => {
    const good = docFor(CPG_SCHEMA);
    const header = `# Node labels (${CPG_SCHEMA.nodes.length})`;
    const text = good.replace(header, '# Node label (hand-edited)');
    const root = await workspace(text);
    const r = await cli(['schema', '--check', '--workspace', root], realEngine());
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.stdout).toEqual([]);
    expect(r.stderr).toMatch(/^cpg: /);
    expect(r.stderr).toContain(join(root, DOC));
    expect(r.stderr).toContain('stale');
    expect(r.stderr).toContain(`line ${lineOf(good, header)}`);
    expect(await readFile(join(root, DOC), 'utf8')).toBe(text);
  });

  it('renders from engine.schema(): a doc of the engine schema passes, a doc of CPG_SCHEMA fails', async () => {
    const f = fakeEngine(SMALL);
    const ok = await cli(
      ['schema', '--check', '--workspace', await workspace(docFor(SMALL))],
      f.engine,
    );
    expect(ok.code).toBe(EXIT.OK);
    expect(f.calls()).toBe(1);
    const stale = await cli(
      ['schema', '--check', '--workspace', await workspace(docFor(CPG_SCHEMA))],
      f.engine,
    );
    expect(stale.code).toBe(EXIT.FAILED);
    // line 3 is the region's header line, which carries the schema version (99 vs 3)
    expect(stale.stderr).toContain('line 3');
  });

  it('malformed markers exit 1 with the splicer message', async () => {
    const root = await workspace(`top: 1\n${GENERATED_BEGIN} (fixture)\nnodes: []\n`);
    const r = await cli(['schema', '--check', '--workspace', root], realEngine());
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.stdout).toEqual([]);
    expect(r.stderr).toContain(
      'expected exactly one line starting with "# END GENERATED", found 0',
    );
  });

  it('a workspace with no docs/outline/04-schema.yaml exits 1: cannot read, naming the path', async () => {
    const root = await workspace();
    const r = await cli(['schema', '--check', '--workspace', root], realEngine());
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.stdout).toEqual([]);
    expect(r.stderr).toContain('cannot read');
    expect(r.stderr).toContain(join(root, DOC));
  });

  it('the root is --workspace, then CPG_WORKSPACE, then cwd; a relative --workspace resolves against cwd', async () => {
    const good = await workspace(docFor(CPG_SCHEMA));
    const empty = await workspace();
    // each first source is honoured over the later ones, which point at a workspace with no doc
    expect(await check(['--workspace', good], { env: { CPG_WORKSPACE: empty }, cwd: empty })).toBe(
      EXIT.OK,
    );
    expect(await check([], { env: { CPG_WORKSPACE: good }, cwd: empty })).toBe(EXIT.OK);
    expect(await check([], { cwd: good })).toBe(EXIT.OK);
    expect(await check([], { cwd: empty })).toBe(EXIT.FAILED);
    expect(await check(['--workspace', basename(good)], { cwd: dirname(good) })).toBe(EXIT.OK);
  });
});
