// C-EXTRACT I2: extract performs no I/O. A child node installs a Module._load trap BEFORE requiring the
// built package (dist, written by tsc -b before vitest in `bun run check`; CS-6: a trap inside vitest
// observes nothing), then runs a real extract and seal. Loading may request only relative modules,
// @cpg/model and node:crypto; extract and seal may request nothing. Allowing node:crypto (createHash
// for interfaceHash, decision 94) goes beyond the contract's text. If the package's own modules did not
// load through the trap (a native-ESM build, Q4), the probe fails loudly instead of passing empty.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const DIST = join(realpathSync(join(__dirname, '..')), 'dist', 'index.js');
const ALLOWED = new Set(['@cpg/model', 'node:crypto']);

const PROBE = `
const Module = require('node:module');
const loads = { require: [], run: [] };
let phase = 'require';
const load = Module._load;
Module._load = function (request, ...rest) {
  loads[phase].push(request);
  return load.call(this, request, ...rest);
};
let result = null;
let failure = null;
try {
  const api = require(process.argv[1]);
  phase = 'run';
  const at = (row, column) => ({ row, column });
  const leaf = (type, row) => ({ type, startPosition: at(row, 0), endPosition: at(row, 5),
    startIndex: 0, endIndex: 5, namedChildren: [], childForFieldName: () => null, text: 'x = 1' });
  const root = { ...leaf('module', 0), endPosition: at(2, 0), namedChildren: [leaf('expression_statement', 0)] };
  const out = api.createExtractor().extract({ path: 'main.py', grammarId: 'python', root,
    revision_id: 'r', lineCount: 2 });
  const sealed = out.kind === 'ok' ? api.sealExtractedFiles([out.file]).kind : 'not sealed';
  result = { extract: out.kind, seal: sealed, nodes: out.kind === 'ok' ? out.file.nodes.length : 0 };
} catch (error) { failure = String(error); }
process.stdout.write(JSON.stringify({ loads, result, failure }));
`;

interface Probe {
  readonly loads: { readonly require: readonly string[]; readonly run: readonly string[] };
  readonly result: unknown;
  readonly failure: string | null;
}

function isProbe(value: unknown): value is Probe {
  return (
    typeof value === 'object' &&
    value !== null &&
    'loads' in value &&
    typeof value.loads === 'object' &&
    value.loads !== null &&
    'require' in value.loads &&
    Array.isArray(value.loads.require) &&
    'run' in value.loads &&
    Array.isArray(value.loads.run) &&
    'result' in value &&
    'failure' in value
  );
}

/** Runs the probe on `entry` in a plain node child. */
function probe(entry: string): Probe {
  const run = spawnSync(process.execPath, ['-e', PROBE, entry], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const parsed: unknown = JSON.parse(run.stdout === '' ? 'null' : run.stdout);
  if (!isProbe(parsed)) throw new Error(`the probe printed nothing usable: ${run.stderr}`);
  return parsed;
}

const relative = (request: string) => request.startsWith('./') || request.startsWith('../');

/** I2's verdict on one probe: every request that breaks the rule, or the loud ESM failure. */
function violations({ loads }: Probe): string[] {
  const own = loads.require.filter(relative);
  return [
    ...(own.length === 0 ? ['the package did not load through Module._load'] : []),
    ...loads.require.filter((r) => !relative(r) && !ALLOWED.has(r) && r !== entryOf(loads)),
    ...loads.run.map((r) => `during extract: ${r}`),
  ];
}

/** The probe's own require of the entry is not the package loading something. */
function entryOf(loads: Probe['loads']): string | undefined {
  return loads.require[0];
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A CommonJS module with `body`, in a fresh temporary directory. */
function plant(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'extract-purity-'));
  temporary.push(dir);
  const file = join(dir, 'plant.cjs');
  writeFileSync(file, body);
  return file;
}

describe('extract performs no I/O (I2)', () => {
  // A spawned node process can take seconds to start on a busy macOS runner.
  it(
    'loads only its own modules, @cpg/model and node:crypto, and nothing while it runs',
    { timeout: 20_000 },
    () => {
      const loaded = probe(DIST);
      expect(loaded.failure).toBeNull();
      expect(loaded.result).toEqual({ extract: 'ok', seal: 'ok', nodes: 1 });
      expect(loaded.loads.require).toContain('@cpg/model');
      expect(violations(loaded)).toEqual([]);
    },
  );

  it('anti-vacuity: reports a package that loads node:fs', { timeout: 20_000 }, () => {
    const entry = plant(
      `module.exports = require(${JSON.stringify(DIST)});\nrequire('node:fs');\n`,
    );
    expect(violations(probe(entry))).toContain('node:fs');
  });

  it('anti-vacuity: reports a require made while extracting', { timeout: 20_000 }, () => {
    const entry = plant(
      [
        `const real = require(${JSON.stringify(DIST)});`,
        'module.exports = { ...real, createExtractor: () => { const x = real.createExtractor();',
        "  return { ...x, extract: (r) => { require('node:path'); return x.extract(r); } }; } };",
      ].join('\n'),
    );
    expect(violations(probe(entry))).toContain('during extract: node:path');
  });

  it('anti-vacuity: fails loudly when nothing loads through the trap', { timeout: 20_000 }, () => {
    const entry = plant(
      'module.exports = { createExtractor: () => ({ extract: () => ({ kind: "failed" }) }) };\n',
    );
    expect(violations(probe(entry))).toContain('the package did not load through Module._load');
  });
});
