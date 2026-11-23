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
  type ConsumerSwitches,
  type CpgEngine,
  type EngineConfig,
  type EngineSession,
  type IndexProgress,
  type IndexReport,
  type Provenanced,
  type ResolvedConfig,
  type StoreTarget,
  type VerifyReport,
} from '@cpg/engine';
import { checkSchemaDoc, type GraphPayload } from '@cpg/model';
import { loadConfig } from './config';
import type { StartInspector } from './inspector-process';
import type { Io, Manifest } from './io';
import { parsePayloadDocument, savedPayloadChecks, serveLive, type LiveEnd } from './live';
import { COMMANDS, RESERVED_VERBS, flagsOf, renderUsage, type CommandSpec } from './spec';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, VERIFY_FAILED: 3, INTERRUPTED: 130 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// The C-CLI CliError kinds this skeleton can raise, plus CLI-local kinds: 'not-built' for reserved
// verbs and SEAT handlers (exit 2; its message tells it apart from the 'unknown command' error),
// 'schema-check' for `cpg schema --check` failures (exit 1), 'payload' for invalid or unreadable
// saved payload inputs (exit 2), and 'inspector' for inspector start or unexpected exit failures
// (exit 1).
export type CliError =
  | { kind: 'usage'; verb?: string; message: string }
  | { kind: 'config'; key: string; layer: ConfigLayer; message: string }
  | { kind: 'not-built'; verb: string; message: string }
  | { kind: 'payload'; message: string }
  | { kind: 'engine-unavailable'; endpoint: string; message: string }
  | { kind: 'inspector'; message: string }
  | { kind: 'verification'; failures: readonly CheckResult[] }
  | { kind: 'schema-check'; message: string }
  | { kind: 'interrupted'; committed: number; pending: number };

// Total (the compiler rejects a kind with no row); the ONLY exit-code decision site.
const EXIT_FOR: { readonly [K in CliError['kind']]: ExitCode } = {
  usage: EXIT.USAGE,
  config: EXIT.USAGE,
  'not-built': EXIT.USAGE,
  payload: EXIT.USAGE,
  'engine-unavailable': EXIT.FAILED,
  inspector: EXIT.FAILED,
  verification: EXIT.VERIFY_FAILED,
  'schema-check': EXIT.FAILED,
  interrupted: EXIT.INTERRUPTED,
};
export const exitCodeFor = (error: CliError): ExitCode => EXIT_FOR[error.kind];

export interface RunOptions {
  readonly manifest: Manifest;
  /**
   * The composition root's engine constructor (owner decision 5a). run calls it once the config has
   * resolved, so the engine builds only the sinks the resolved consumer switches enable.
   */
  readonly createEngine?: (config: EngineConfig) => CpgEngine;
  /**
   * The composition root's inspector launcher (owner decision 9a): main.ts spawns the cpg-inspector
   * bin. `cpg inspect` and `cpg index --inspect` call it once they hold a payload.
   */
  readonly startInspector?: StartInspector;
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
  if (spec.verb === 'schema') return runSchema(spec, values, io, opts);
  if (spec.verb === 'config') return runConfig(spec, values, positionals, io, opts);
  if (spec.verb === 'inspect') return runInspect(spec, positionals, io, opts);
  // SEAT: verbs without a handler yet stop here (watch, query, doctor).
  const seat = new Fail({ kind: 'not-built', verb, message: `'${verb}' is not built yet` });
  if (opts.createEngine === undefined) throw seat;
  if (opts.signal?.aborted) throw new Fail({ kind: 'interrupted', committed: 0, pending: 0 });
  if (spec.verb === 'index') {
    return runIndex(spec, opts.createEngine, values, positionals, io, opts);
  }
  if (spec.verb === 'verify') {
    return runVerify(spec, opts.createEngine, values, positionals, io, opts);
  }
  const target = storeTarget(spec, values);
  if (target) {
    const engine = opts.createEngine({
      version: opts.manifest.version,
      consumers: DEFAULT_CONSUMERS,
    });
    const session = await connectStore(engine, target, spec.session === 'read');
    await session.close();
  }
  throw seat;
}

const DEFAULT_CONSUMERS: ConsumerSwitches = {
  inspect: CONFIG_DEFAULTS['consumers.inspect'],
  store: CONFIG_DEFAULTS['consumers.store'],
  vscode: CONFIG_DEFAULTS['consumers.vscode'],
};

const noop = (): void => {};

function describeConsumer(
  key: 'store' | 'inspect' | 'vscode',
  entry: Provenanced<unknown>,
  what: string,
): string {
  return `consumers.${key} ${JSON.stringify(entry.value)} from ${entry.layer} ${entry.source} (${what})`;
}

function refuseUnbuiltConsumers(verb: string, resolved: ResolvedConfig): void {
  const { store, inspect, vscode } = resolved.consumers;
  const parts: string[] = [];
  if (store.value === 'falkor') parts.push(describeConsumer('store', store, 'FalkorStore, U5'));
  if (verb === 'verify' && inspect.value) {
    parts.push(
      describeConsumer(
        'inspect',
        inspect,
        'cpg verify does not start the inspector; use cpg index --inspect',
      ),
    );
  }
  if (vscode.value) parts.push(describeConsumer('vscode', vscode, 'the VS Code panel, U3'));
  if (parts.length > 0) {
    throw new Fail({
      kind: 'not-built',
      verb,
      message: `not built yet: ${parts.join('; ')}`,
    });
  }
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

const targetOf = (resolved: ResolvedConfig): StoreTarget => ({
  host: resolved.store.host.value,
  port: resolved.store.port.value,
  graph: resolved.store.graph.value,
});

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
  buildEngine: (config: EngineConfig) => CpgEngine,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): Promise<ExitCode> {
  // REAL
  const { resolved } = await load(spec, values, positionals, io, opts);
  refuseUnbuiltConsumers(spec.verb, resolved);
  const config = toCpgConfigInput(resolved);
  const engine = buildEngine({ version: opts.manifest.version, consumers: config.consumers });
  const target = targetOf(resolved);
  const writeSession = await connectStore(engine, target, false);
  let indexed: IndexReport;
  try {
    indexed = await engine.index(
      { config, session: writeSession, resumeFrom: null },
      noop,
      opts.signal ?? new AbortController().signal,
    );
  } finally {
    await writeSession.close();
  }
  for (const w of indexed.warnings) {
    io.err(`cpg: warning: ${w}`);
  }
  if (indexed.interrupted) {
    throw new Fail({ kind: 'interrupted', committed: 0, pending: 0 });
  }

  const session = await connectStore(engine, target, true);
  let report: VerifyReport;
  try {
    report = await engine.verify(session, { ...config, strict: values['strict'] === true }, null);
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
  if (opts.createEngine === undefined) {
    throw new Fail({ kind: 'not-built', verb: 'schema', message: "'schema' is not built yet" });
  }
  const engine = opts.createEngine({
    version: opts.manifest.version,
    consumers: DEFAULT_CONSUMERS,
  });
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

function readErrorDetail(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runLive(
  payload: GraphPayload,
  checks: readonly CheckResult[],
  io: Io,
  opts: RunOptions,
  start: StartInspector,
): Promise<ExitCode> {
  let end: LiveEnd;
  try {
    end = await serveLive({
      payload,
      checks,
      start,
      io,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Fail({ kind: 'inspector', message: `cannot start the inspector: ${message}` });
  }
  if (end.kind === 'interrupted') {
    throw new Fail({ kind: 'interrupted', committed: 0, pending: 0 });
  }
  const { code, signal } = end.exit;
  const how = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
  throw new Fail({ kind: 'inspector', message: `the inspector exited unexpectedly (${how})` });
}

async function runInspect(
  spec: CommandSpec,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): Promise<ExitCode> {
  // REAL
  const arg = positionals[0];
  if (arg === undefined) {
    throw new Fail({
      kind: 'usage',
      verb: spec.verb,
      message: 'pass a cpg.graph.payload file, or - for stdin',
    });
  }
  if (opts.startInspector === undefined) {
    throw new Fail({ kind: 'not-built', verb: spec.verb, message: "'inspect' is not built yet" });
  }
  const source = arg === '-' ? 'stdin' : opts.cwd !== undefined ? resolve(opts.cwd, arg) : arg;
  let text: string;
  if (arg === '-') {
    text = await io.stdin.readText();
  } else {
    try {
      text = await readFile(source, 'utf8');
    } catch (e: unknown) {
      throw new Fail({
        kind: 'payload',
        message: `payload: cannot read ${source} (${readErrorDetail(e)})`,
      });
    }
  }
  const parsed = parsePayloadDocument(text);
  if (!parsed.ok) {
    throw new Fail({ kind: 'payload', message: `payload: ${source}: ${parsed.reason}` });
  }
  for (const w of parsed.warnings) {
    io.err(`cpg: warning: ${w}`);
  }
  if (opts.signal?.aborted === true) {
    throw new Fail({ kind: 'interrupted', committed: 0, pending: 0 });
  }
  return runLive(
    parsed.payload,
    savedPayloadChecks(parsed.payload.seq),
    io,
    opts,
    opts.startInspector,
  );
}

async function runIndex(
  spec: CommandSpec,
  buildEngine: (config: EngineConfig) => CpgEngine,
  values: Values,
  positionals: readonly string[],
  io: Io,
  opts: RunOptions,
): Promise<ExitCode> {
  // REAL
  const { resolved } = await load(spec, values, positionals, io, opts);
  const dryRun = values['dry-run'] === true;
  const inspect = resolved.consumers.inspect;
  if (dryRun && inspect.value) {
    throw new Fail({
      kind: 'usage',
      verb: spec.verb,
      message: describeConsumer(
        'inspect',
        inspect,
        'the inspector reads the indexed store, and --dry-run has none',
      ),
    });
  }
  if (!dryRun) {
    refuseUnbuiltConsumers(spec.verb, resolved);
  }
  const startInspector = inspect.value ? opts.startInspector : undefined;
  if (inspect.value && startInspector === undefined) {
    throw new Fail({
      kind: 'not-built',
      verb: spec.verb,
      message: "'index --inspect' is not built yet",
    });
  }
  const config = toCpgConfigInput(resolved);
  const engine = buildEngine({ version: opts.manifest.version, consumers: config.consumers });
  const quiet = values['quiet'] === true;
  const onProgress = (p: IndexProgress): void => {
    if (!quiet) io.status(`index: ${p.phase} ${p.filesTotal} files`);
  };
  const signal = opts.signal ?? new AbortController().signal;

  let report: IndexReport;
  if (dryRun) {
    report = await engine.index({ config, session: null, resumeFrom: null }, onProgress, signal);
  } else {
    const session = await connectStore(engine, targetOf(resolved), false);
    try {
      report = await engine.index({ config, session, resumeFrom: null }, onProgress, signal);
    } finally {
      await session.close();
    }
  }

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

  if (report.interrupted) {
    return EXIT.INTERRUPTED;
  }

  if (startInspector !== undefined) {
    const readSession = await connectStore(engine, targetOf(resolved), true);
    let verified: VerifyReport;
    let payload: GraphPayload;
    try {
      verified = await engine.verify(readSession, config, null);
      payload = await engine.inspect(readSession, config);
    } finally {
      await readSession.close();
    }
    return runLive(payload, verified.checks, io, opts, startInspector);
  }

  return EXIT.OK;
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

// SEAT: used only by verbs without a handler yet (watch, query).
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
