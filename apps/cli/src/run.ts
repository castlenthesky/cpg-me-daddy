// run(argv, io, opts): everything between argv and the first engine call, and between the last
// engine return and stdout. Pure w.r.t. ambient state: no process.*, no clock outside io.now (I-30).

import { parseArgs } from 'node:util';
import type { CpgEngine, StoreTarget } from '@cpg/engine';
import type { Io, Manifest } from './io';
import { COMMANDS, RESERVED_VERBS, flagsOf, renderUsage, type CommandSpec } from './spec';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, VERIFY_FAILED: 3, INTERRUPTED: 130 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// The C-CLI CliError kinds this skeleton can raise, plus 'not-built' for reserved verbs and SEAT
// handlers (exit 2; its message tells it apart from the 'unknown command' error).
export type CliError =
  | { kind: 'usage'; verb?: string; message: string }
  | { kind: 'not-built'; verb: string; message: string }
  | { kind: 'engine-unavailable'; endpoint: string; message: string }
  | { kind: 'interrupted'; committed: number; pending: number };

// Total (the compiler rejects a kind with no row); the ONLY exit-code decision site.
const EXIT_FOR: { readonly [K in CliError['kind']]: ExitCode } = {
  usage: EXIT.USAGE,
  'not-built': EXIT.USAGE,
  'engine-unavailable': EXIT.FAILED,
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

  const values = parseFlags(spec, rest);
  if (values['help'] === true) {
    io.out(renderUsage(spec));
    return EXIT.OK;
  }
  // Every flag is validated before anything touches the engine (I-12).
  const target = storeTarget(spec, values);
  // SEAT: no verb has a handler until the engine exists (U2a.2+). Until then every verb stops here.
  const seat = new Fail({ kind: 'not-built', verb, message: `'${verb}' is not built yet` });
  if (!opts.engine) throw seat;
  if (opts.signal?.aborted) throw new Fail({ kind: 'interrupted', committed: 0, pending: 0 });
  if (target) {
    const session = await opts.engine
      .connect(target, { readOnly: spec.session === 'read' })
      .catch((e: unknown) => {
        const endpoint = `${target.host}:${target.port}/${target.graph}`;
        const message = `cannot reach the graph store at ${endpoint}: ${String(e)}`;
        throw new Fail({ kind: 'engine-unavailable', endpoint, message });
      });
    await session.close();
  }
  throw seat;
}

type Values = Record<string, string | boolean | undefined>;

function parseFlags(spec: CommandSpec, args: readonly string[]): Values {
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
  return parsed.values;
}

const isPort = (v: string): boolean => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

// Store defaults are provisional until the config loader (U2): 6382, never the harness's 6381.
function storeTarget(spec: CommandSpec, values: Values): StoreTarget | null {
  if (spec.session === 'none') return null;
  const str = (k: string, d: string) => (typeof values[k] === 'string' ? values[k] : d);
  return {
    host: str('host', 'localhost'),
    port: Number(str('port', '6382')),
    graph: str('graph', 'cpg'),
  };
}
