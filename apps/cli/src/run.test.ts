import { describe, expect, it } from 'vitest';
import type { CpgEngine, StoreTarget } from '@cpg/engine';
import { captureIo } from './io';
import { EXIT, exitCodeFor, run } from './run';
import { COMMANDS, RESERVED_VERBS, flagsOf, renderUsage } from './spec';

const manifest = { bin: 'cpg', version: '9.8.7' };

function fakeEngine(fail = false) {
  const connects: StoreTarget[] = [];
  let closed = 0;
  const engine: CpgEngine = {
    identity: { name: 'fake', version: '0', languages: [] },
    connect: (target) => {
      connects.push(target);
      if (fail) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve({ target, close: () => Promise.resolve(void closed++) });
    },
    index: () => Promise.reject(new Error('fakeEngine.index is not driven by these tests')),
  };
  return { engine, connects, closed: () => closed };
}

async function cli(
  argv: string[],
  o: { isTty?: boolean; engine?: CpgEngine; signal?: AbortSignal } = {},
) {
  const io = captureIo({ isTty: o.isTty ?? false });
  const code = await run(argv, io, {
    manifest,
    ...(o.engine && { engine: o.engine }),
    ...(o.signal && { signal: o.signal }),
  });
  return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n') };
}

describe('usage is derived from CommandSpec (I-7)', () => {
  it.each(COMMANDS.map((c) => [c.verb, c] as const))(
    '%s: flags === --tokens in usage',
    (_, spec) => {
      const tokens = new Set(renderUsage(spec).match(/--[a-z][a-z-]*/g));
      expect(tokens).toEqual(new Set(flagsOf(spec).map((f) => `--${f.name}`)));
    },
  );

  it.each(COMMANDS.map((c) => c.verb))(
    '%s --help prints its usage on stdout, exit 0',
    async (verb) => {
      const r = await cli([verb, '--help']);
      expect(r).toEqual({
        code: EXIT.OK,
        out: renderUsage(COMMANDS.find((c) => c.verb === verb)),
        err: '',
      });
    },
  );

  it('top-level --help lists every verb', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(EXIT.OK);
    for (const c of COMMANDS) expect(r.out).toContain(c.verb);
  });
});

describe('exit codes', () => {
  it('--version prints the manifest banner', async () => {
    expect(await cli(['--version'])).toEqual({ code: EXIT.OK, out: 'cpg 9.8.7', err: '' });
  });

  it.each([
    [[]],
    [['frobnicate']],
    [['index', '--nope']],
    [['schema', 'extra']],
    [['index', '--format', 'xml']],
  ])('usage error %j exits 2 with nothing on stdout', async (argv) => {
    const r = await cli(argv);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/^cpg: /);
  });

  it('unknown verb is distinguishable from a reserved one', async () => {
    expect((await cli(['frobnicate'])).err).toContain("unknown command 'frobnicate'");
    for (const verb of RESERVED_VERBS) {
      const r = await cli([verb]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.err).toContain('not built yet');
      expect(r.err).not.toContain('unknown command');
    }
  });

  it.each(COMMANDS.map((c) => c.verb))('%s is a SEAT: exits 2 "not built yet"', async (verb) => {
    for (const engine of [undefined, fakeEngine().engine]) {
      const r = await cli([verb], engine ? { engine } : {});
      expect(r).toEqual({ code: EXIT.USAGE, out: '', err: `cpg: '${verb}' is not built yet` });
    }
  });

  it.each(['abc', '0', '65536', '63.5', ''])(
    'malformed --port %j exits 2 with no connect',
    async (port) => {
      const f = fakeEngine();
      const r = await cli(['query', '--port', port], { engine: f.engine });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.err).toContain('--port');
      expect(f.connects).toHaveLength(0);
    },
  );

  it('a well-formed --port reaches engine.connect (the test above is not vacuous)', async () => {
    const f = fakeEngine();
    await cli(['query', '--port', '7000', '--graph', 'g'], { engine: f.engine });
    expect(f.connects).toEqual([{ host: 'localhost', port: 7000, graph: 'g' }]);
    expect(f.closed()).toBe(1);
  });

  it('a failed connect exits 1', async () => {
    const r = await cli(['verify'], { engine: fakeEngine(true).engine });
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.err).toContain('localhost:6382/cpg');
  });

  it('an aborted signal exits 130 before connecting', async () => {
    const f = fakeEngine();
    const r = await cli(['index'], { engine: f.engine, signal: AbortSignal.abort() });
    expect(r.code).toBe(EXIT.INTERRUPTED);
    expect(f.connects).toHaveLength(0);
    expect(exitCodeFor({ kind: 'interrupted', committed: 0, pending: 0 })).toBe(130);
  });
});

describe('--format is never inferred (I-9)', () => {
  const cases = [
    ['--version'],
    ['--help'],
    ['frobnicate'],
    ['mcp'],
    ...COMMANDS.map((c) => [c.verb, '--help']),
  ];
  it.each(cases)('%j: stdout identical with isTty true and false', async (...argv) => {
    const [tty, pipe] = [await cli(argv, { isTty: true }), await cli(argv, { isTty: false })];
    expect(tty.out).toBe(pipe.out);
    expect(tty.code).toBe(pipe.code);
  });
});

describe('captureIo', () => {
  it('records status only on a TTY and serves stdin', async () => {
    const [tty, pipe] = [captureIo({ isTty: true, stdin: 'x' }), captureIo()];
    tty.status('s');
    pipe.status('s');
    expect([tty.stderr, pipe.stderr]).toEqual([['s'], []]);
    expect([await tty.stdin.readText(), await pipe.stdin.readText(), tty.now()]).toEqual([
      'x',
      '',
      0,
    ]);
  });
});
