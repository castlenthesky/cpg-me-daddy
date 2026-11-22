// CommandSpec: the single flag table per verb (C-CLI). The parser and renderUsage both read
// flagsOf(spec), so usage can never drift from what is accepted (I-7).

type Verb = 'index' | 'watch' | 'query' | 'verify' | 'inspect' | 'doctor' | 'config' | 'schema';
export const RESERVED_VERBS: readonly string[] = ['mcp', 'status'];

export interface FlagSpec {
  readonly name: string;
  readonly summary: string;
  // 'port' is a string on argv, validated to an integer in 1..65535 before any engine call (I-12).
  readonly type: 'boolean' | 'string' | 'port';
  readonly values?: readonly string[];
}
interface PositionalSpec {
  readonly name: string;
  readonly summary: string;
}
export interface CommandSpec {
  readonly verb: Verb;
  readonly summary: string;
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  readonly stdin: 'none' | 'optional-document' | 'required-document';
  readonly stdout: 'document' | 'ndjson' | 'none';
  // Which store session the verb opens through engine.connect, if any.
  readonly session: 'read' | 'write' | 'none';
}

const HELP: FlagSpec = { name: 'help', type: 'boolean', summary: 'print this usage and exit' };
const format = (...values: string[]): FlagSpec => ({
  name: 'format',
  type: 'string',
  values,
  summary: 'output format; never inferred from the terminal',
});
const workspace: FlagSpec = { name: 'workspace', type: 'string', summary: 'workspace root' };
// No port default here: nothing user-facing may default to 6381, the test harness port (I-16).
const store: readonly FlagSpec[] = [
  { name: 'host', type: 'string', summary: 'graph store host' },
  { name: 'port', type: 'port', summary: 'graph store port' },
  { name: 'graph', type: 'string', summary: 'graph key' },
];
const root: PositionalSpec = { name: 'root', summary: 'workspace root, when no flag names one' };
const bool = (name: string, summary: string): FlagSpec => ({ name, type: 'boolean', summary });
// Defaults shared by most verbs: a workspace positional, no stdin, one document on stdout.
const cmd = (
  verb: Verb,
  summary: string,
  session: CommandSpec['session'],
  flags: readonly FlagSpec[],
  rest: Partial<Pick<CommandSpec, 'positionals' | 'stdin' | 'stdout'>> = {},
): CommandSpec => ({
  verb,
  summary,
  session,
  flags,
  positionals: [root],
  stdin: 'none',
  stdout: 'document',
  ...rest,
});

export const COMMANDS: readonly CommandSpec[] = [
  cmd('index', 'index a workspace into the graph and print an index report', 'write', [
    workspace,
    format('text', 'json'),
    ...store,
    bool('dry-run', 'index without a store'),
    bool('rebuild', 'drop and recreate the graph key'),
    bool('quiet', 'no progress on stderr'),
  ]),
  cmd(
    'watch',
    'index, then stream change batches as NDJSON',
    'write',
    [workspace, format('ndjson'), ...store],
    { stdout: 'ndjson' },
  ),
  cmd(
    'query',
    'run a read-only query against the graph',
    'read',
    [format('text', 'json'), ...store, { name: 'timeout', type: 'string', summary: 'ms' }],
    {
      positionals: [{ name: 'cypher', summary: 'query text (or a document on stdin)' }],
      stdin: 'optional-document',
    },
  ),
  cmd('verify', 'run the six verify checks; exit 3 when the graph does not pass', 'read', [
    workspace,
    format('text', 'json'),
    ...store,
    bool('strict', 'treat unavailable checks as failures'),
  ]),
  cmd('inspect', 'emit the graph payload, or serve the browser inspector', 'read', [
    workspace,
    format('json'),
    ...store,
    bool('serve', 'start the local inspector server'),
  ]),
  cmd('doctor', 'diagnose the installation and the store', 'none', [format('text', 'json')], {
    positionals: [],
  }),
  cmd('config', 'print the resolved config with the layer and source of every key', 'none', [
    workspace,
    format('text', 'json'),
  ]),
  cmd(
    'schema',
    'print the graph schema, or check docs/outline/04-schema.yaml for drift',
    'none',
    [
      bool('print', 'print the schema as one cpg.schema document'),
      bool('check', 'exit 1 when the generated region of docs/outline/04-schema.yaml is stale'),
      workspace,
      format('json'),
    ],
    { positionals: [] },
  ),
];

export const flagsOf = (spec: CommandSpec): readonly FlagSpec[] => [...spec.flags, HELP];

const flagUsage = (f: FlagSpec): string =>
  f.type === 'boolean' ? `--${f.name}` : `--${f.name} <${f.values?.join('|') ?? f.type}>`;

// The ONLY producer of usage text. With no spec, the top-level usage.
export function renderUsage(spec?: CommandSpec): string {
  if (!spec) {
    const width = Math.max(...COMMANDS.map((c) => c.verb.length));
    return [
      'usage: cpg <command> [flags]',
      '',
      'commands:',
      ...COMMANDS.map((c) => `  ${c.verb.padEnd(width)}  ${c.summary}`),
      '',
      'cpg --version    print the version',
      'cpg <command> --help    usage for one command',
    ].join('\n');
  }
  const flags = flagsOf(spec);
  const width = Math.max(...flags.map((f) => flagUsage(f).length));
  return [
    `usage: cpg ${spec.verb}${spec.positionals.map((p) => ` [${p.name}]`).join('')} [flags]`,
    '',
    spec.summary,
    ...spec.positionals.map((p) => `  ${p.name}  ${p.summary}`),
    '',
    'flags:',
    ...flags.map((f) => `  ${flagUsage(f).padEnd(width)}  ${f.summary}`),
  ].join('\n');
}
