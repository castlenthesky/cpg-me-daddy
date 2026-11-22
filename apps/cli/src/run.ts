// run(argv, io, opts): everything between argv and the first engine call, and between the last
// engine return and stdout. Pure w.r.t. ambient state: no process.*, no clock outside io.now (I-30).

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CONFIG_DEFAULTS,
  ConfigError,
  toCpgConfigInput,
  type CheckResult,
  type ConfigLayer,
  type ConfigLayerInput,
  type CpgEngine,
  type EngineSession,
  type IndexProgress,
  type ResolvedConfig,
  type StoreTarget,
  type VerifyReport,
} from '@cpg/engine';
import { checkSchemaDoc } from '@cpg/model';
import { loadConfig } from './config';
import type { Io, Manifest } from './io';
import { COMMANDS, RESERVED_VERBS, flagsOf, renderUsage, type CommandSpec } from './spec';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, VERIFY_FAILED: 3, INTERRUPTED: 130 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// The C-CLI CliError kinds this skeleton can raise, plus 'not-built' for reserved verbs and SEAT
// handlers (exit 2; its message tells it apart from the 'unknown command' error) and 'schema-check'
// for `cpg schema --check` failures (CLI-local like 'not-built', exit 1).
export type CliError =
  | { kind: 'usage'; verb?: string; message: string }
  | { kind: 'config'; key: string; layer: ConfigLayer; message: string }
  | { kind: 'not-built'; verb: string; message: string }
  | { kind: 'engine-unavailable'; endpoint: string; message: string }
  | { kind: 'verification'; failures: readonly CheckResult[] }
  | { kind: 'schema-check'; message: string }
  | { kind: 'interrupted'; committed: number; pending: number };

// Total (the compiler rejects a kind with no row); the ONLY exit-code decision site.
const EXIT_FOR: { readonly [K in CliError['kind']]: ExitCode } = {
  usage: EXIT.USAGE,
  config: EXIT.USAGE,
  'not-built': EXIT.USAGE,
  'engine-unavailable': EXIT.FAILED,
  verification: EXIT.VERIFY_FAILED,
  'schema-check': EXIT.FAILED,
  interrupted: EXIT.INTERRUPTED,
};
export const exitCodeFor = (error: CliError): ExitCode => EXIT_FOR[error.kind];

export interface RunOptions {
  readonly manifest: Manifest;
  readonly engine?: CpgEngine;
  readonly signal?: AbortSignal;
  /** The process working directory, read in main.ts: the last workspace-root fallback (C-CLI). */
  readonly cwd?: string;
}

class Fail extends Error {
  constructor(readonly error: CliError) {
    super(error.kind);
  }
}

export async function run(argv: readonly string[], io: Io, opts: RunOptions): Promise<ExitCode> {
  try {
    return await dispatch(argv, io, opts);
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    const { error } = e;
    if (error.kind === 'interrupted') io.err('cpg: interrupted');
    else if (error.kind === 'verification')
      io.err(`cpg: verify failed: ${error.failures.map((f) => f.id).join(', ')}`);
    else io.err(`cpg: ${error.message}`);
    if (error.kind === 'usage')
      io.err(error.verb ? `run 'cpg ${error.verb} --help'` : renderUsage());
    return exitCodeFor(error);
  }
}

async function dispatch(argv: readonly string[], io: Io, opts: RunOptions): Promise<ExitCode> {
  const [verb, ...rest] = argv;
  if (verb === undefined) throw new Fail({ kind: 'usage', message: 'no command given' });
  if (verb === '--version' && rest.length === 0) {
    io.out(`${opts.manifest.bin} ${opts.manifest.version}`);
    return EXIT.OK;
  }
  if ((verb === '--help' || verb === '-h') && rest.length === 0) {
    io.out(renderUsage());
    return EXIT.OK;
  }
  if (RESERVED_VERBS.includes(verb))
    throw new Fail({ kind: 'not-built', verb, message: `'${verb}' is reserved: not built yet` });
  const spec = COMMANDS.find((c) => c.verb === verb);
  if (!spec) throw new Fail({ kind: 'usage', message: `unknown command '${verb}'` });

  const { values, positionals } = parseFlags(spec, rest);
  if (values['help'] === true) {
    io.out(renderUsage(spec));
    return EXIT.OK;
  }
  // Every flag is validated before anything touches the engine (I-12).
  if (spec.verb === 'schema') return runSchema(spec, opts.engine, values, io, opts);
  if (spec.verb === 'config') return runConfig(spec, values, positionals, io, opts);
  // SEAT: verbs without a handler yet stop here (watch, query, inspect, doctor, index without --dry-run).
  const seat = new Fail({ kind: 'not-built', verb, message: `'${verb}' is not built yet` });
  if (!opts.engine) throw seat;
  if (opts.signal?.aborted) throw new Fail({ kind: 'interrupted', committed: 0, pending: 0 });
  if (spec.verb === 'index' && values['dry-run'] === true) {
    return runIndexDryRun(spec, opts.engine, values, positionals, io, opts);
  }
  if (spec.verb === 'verify') {
    return runVerify(spec, opts.engine, values, positionals, io, opts);
  }
  const target = storeTarget(spec, values);
  if (target) {
    const session = await connectStore(opts.engine, target, spec.session === 'read');
    await session.close();
  }
  throw seat;
}

function rootLayers(
  spec: CommandSpec,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): readonly ConfigLayerInput[] {
  const layers: ConfigLayerInput[] = [];
  const add = (layer: ConfigLayer, source: string, raw: string | undefined): void => {
    if (raw === undefined) return;
    const root = opts.cwd !== undefined ? resolve(opts.cwd, raw) : raw;
    layers.push({ layer, source, values: { root } });
  };
  add(
    'flag',
    '--workspace',
    typeof values['workspace'] === 'string' ? values['workspace'] : undefined,
  );
  if (spec.positionals[0]?.name === 'root') {
    add('flag', '<root>', positionals[0]);
  }
  add('env', 'CPG_WORKSPACE', io.env['CPG_WORKSPACE']);
  add('default', 'cwd', opts.cwd);
  if (layers.length === 0) {
    throw new Fail({
      kind: 'usage',
      verb: spec.verb,
      message: 'no workspace root: pass --workspace or a root',
    });
  }
  return layers;
}

// The winning root: rootLayers lists the sources in precedence order, so it is the first.
function resolveWorkspaceRoot(
  spec: CommandSpec,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): string {
  return String(rootLayers(spec, values, positionals, io, opts)[0]?.values['root']);
}

async function load(
  spec: CommandSpec,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): Promise<{ readonly resolved: ResolvedConfig; readonly file: string | null }> {
  const roots = rootLayers(spec, values, positionals, io, opts);
  try {
    const result = await loadConfig({
      rootLayers: roots,
      values,
      env: io.env,
      cwd: opts.cwd,
    });
    for (const w of result.warnings) {
      io.err(`cpg: warning: ${w}`);
    }
    return { resolved: result.resolved, file: result.file };
  } catch (e: unknown) {
    if (e instanceof ConfigError) {
      throw new Fail({
        kind: 'config',
        key: e.key,
        layer: e.layer,
        message: e.message,
      });
    }
    throw e;
  }
}

async function connectStore(
  engine: CpgEngine,
  target: StoreTarget,
  readOnly: boolean,
): Promise<EngineSession> {
  return engine.connect(target, { readOnly }).catch((e: unknown) => {
    const endpoint = `${target.host}:${target.port}/${target.graph}`;
    const message = `cannot reach the graph store at ${endpoint}: ${String(e)}`;
    throw new Fail({ kind: 'engine-unavailable', endpoint, message });
  });
}

function formatDocument(kind: string, body: unknown, io: Io, manifest: Manifest): string {
  return JSON.stringify({
    v: 1,
    kind,
    tool: `${manifest.bin}@${manifest.version}`,
    producedAt: new Date(io.now()).toISOString(),
    body,
  });
}

// One `key value layer source` line per Provenanced leaf, in ResolvedConfig declaration order.
function configLines(v: unknown, prefix = ''): string[] {
  if (typeof v !== 'object' || v === null) return [];
  if ('layer' in v && 'source' in v && 'value' in v)
    return [`${prefix} ${JSON.stringify(v.value)} ${String(v.layer)} ${String(v.source)}`];
  return Object.entries(v).flatMap(([k, x]) => configLines(x, prefix ? `${prefix}.${k}` : k));
}

async function runConfig(
  spec: CommandSpec,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): Promise<ExitCode> {
  // REAL
  const { resolved, file } = await load(spec, values, positionals, io, opts);
  if (values['format'] === 'json') {
    io.out(formatDocument('cpg.config.resolved', resolved, io, opts.manifest));
  } else {
    for (const line of configLines(resolved)) io.out(line);
  }
  io.err(file !== null ? `cpg: config file: ${file}` : 'cpg: config file: none');
  return EXIT.OK;
}

async function runVerify(
  spec: CommandSpec,
  engine: CpgEngine,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): Promise<ExitCode> {
  // REAL
  const { resolved } = await load(spec, values, positionals, io, opts);
  const target: StoreTarget = {
    host: resolved.store.host.value,
    port: resolved.store.port.value,
    graph: resolved.store.graph.value,
  };
  const session = await connectStore(engine, target, true);
  let report: VerifyReport;
  try {
    report = await engine.verify(
      session,
      { ...toCpgConfigInput(resolved), strict: values['strict'] === true },
      null,
    );
  } finally {
    await session.close();
  }

  if (values['format'] === 'json') {
    io.out(formatDocument('cpg.verify.report', report, io, opts.manifest));
  } else {
    io.out(`verify ${report.state}`);
    for (const check of report.checks) {
      const where = check.localisedTo.length > 0 ? ` at ${check.localisedTo.join(', ')}` : '';
      io.out(
        `${check.id} ${check.state} observed=${check.observed} expected=${check.expected}${where}`,
      );
    }
  }

  io.err(
    `cpg: verify ${report.state} in ${Math.round(report.durationMs)} ms; consumers: ${report.consumers.join(', ') || 'none'}`,
  );

  if (report.state === 'fail') {
    throw new Fail({
      kind: 'verification',
      failures: report.checks.filter((c) => c.state === 'fail'),
    });
  }

  return EXIT.OK;
}

async function runSchema(
  spec: CommandSpec,
  engine: CpgEngine | undefined,
  values: Values,
  io: Io,
  opts: RunOptions,
): Promise<ExitCode> {
  // REAL
  const print = values['print'] === true;
  const check = values['check'] === true;
  if (print === check) {
    throw new Fail({
      kind: 'usage',
      verb: 'schema',
      message: 'pass exactly one of --print or --check',
    });
  }
  if (!engine) {
    throw new Fail({ kind: 'not-built', verb: 'schema', message: "'schema' is not built yet" });
  }
  if (print) {
    io.out(formatDocument('cpg.schema', engine.schema(), io, opts.manifest));
    return EXIT.OK;
  }

  const root = resolveWorkspaceRoot(spec, values, [], io, opts);
  const file = join(root, 'docs', 'outline', '04-schema.yaml');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Fail({ kind: 'schema-check', message: `schema: cannot read ${file}` });
  }

  let firstDifferentLine: number | null;
  try {
    firstDifferentLine = checkSchemaDoc(text, engine.schema()).firstDifferentLine;
  } catch (e: unknown) {
    throw new Fail({
      kind: 'schema-check',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (firstDifferentLine === null) {
    io.err(`cpg: schema: ${file} is up to date`);
    return EXIT.OK;
  }
  throw new Fail({
    kind: 'schema-check',
    message: `schema: ${file} generated region is stale (first difference at line ${firstDifferentLine})`,
  });
}

async function runIndexDryRun(
  spec: CommandSpec,
  engine: CpgEngine,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): Promise<ExitCode> {
  // REAL
  const { resolved } = await load(spec, values, positionals, io, opts);
  const quiet = values['quiet'] === true;
  const onProgress = (p: IndexProgress): void => {
    if (!quiet) io.status(`index: ${p.phase} ${p.filesTotal} files`);
  };
  const report = await engine.index(
    { config: toCpgConfigInput(resolved), session: null, resumeFrom: null },
    onProgress,
    opts.signal ?? new AbortController().signal,
  );

  if (values['format'] === 'json') {
    io.out(formatDocument('cpg.index.report', report, io, opts.manifest));
  } else {
    const { walk } = report;
    io.out(`root ${report.root}`);
    io.out(
      `files seen=${walk.filesSeen} indexed=${walk.filesIndexed} excluded=${walk.filesExcluded} unsupported=${walk.filesUnsupported} tooLarge=${walk.filesTooLarge} failed=${walk.filesFailed}`,
    );
    io.out(
      `written nodes=${report.nodesWritten} edges=${report.edgesWritten} dryRun=${report.dryRun}`,
    );
  }

  for (const w of report.warnings) {
    io.err(`cpg: warning: ${w}`);
  }
  io.err(
    `cpg: indexed in ${Math.round(report.durationMs)} ms; consumers: ${report.consumers.join(', ') || 'none'}`,
  );

  return report.interrupted ? EXIT.INTERRUPTED : EXIT.OK;
}

type Values = Record<string, string | boolean | undefined>;

function parseFlags(
  spec: CommandSpec,
  args: readonly string[],
): { readonly values: Values; readonly positionals: readonly string[] } {
  const flags = flagsOf(spec);
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: Object.fromEntries(
        flags.map((f) => [f.name, { type: f.type === 'boolean' ? 'boolean' : 'string' }] as const),
      ),
    });
  } catch (e) {
    throw new Fail({
      kind: 'usage',
      verb: spec.verb,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const usage = (message: string) => new Fail({ kind: 'usage', verb: spec.verb, message });
  if (parsed.positionals.length > spec.positionals.length)
    throw usage(`unexpected argument '${parsed.positionals[spec.positionals.length]}'`);
  for (const f of flags) {
    const v = parsed.values[f.name];
    if (typeof v !== 'string') continue;
    if (f.values && !f.values.includes(v))
      throw usage(`--${f.name} must be one of ${f.values.join(', ')}, got '${v}'`);
    if (f.type === 'port' && !isPort(v))
      throw usage(`--${f.name} must be an integer in 1..65535, got '${v}'`);
  }
  return { values: parsed.values, positionals: parsed.positionals };
}

const isPort = (v: string): boolean => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

// SEAT: used only by verbs without a handler yet (watch, query, inspect, index without --dry-run).
function storeTarget(spec: CommandSpec, values: Values): StoreTarget | null {
  if (spec.session === 'none') return null;
  const str = (k: string, d: string) => (typeof values[k] === 'string' ? values[k] : d);
  return {
    host: str('host', CONFIG_DEFAULTS['store.host']),
    port:
      typeof values['port'] === 'string' ? Number(values['port']) : CONFIG_DEFAULTS['store.port'],
    graph: str('graph', CONFIG_DEFAULTS['store.graph']),
  };
}
