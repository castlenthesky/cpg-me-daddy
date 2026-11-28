import { describe, expect, it } from 'vitest';
import { BrokenChain } from '../test/broken-chain';
import {
  ans,
  at,
  callSite,
  caps,
  CHAIN_CASES,
  FILE,
  link,
  WORKSPACE,
  type MakeChain,
} from '../test/chain-contract';
import { ChainResolver } from './chain';
import type { BackendState, CancellationLike, ResolveContext } from './contract';
import { NullResolver } from './null';

const real: MakeChain = (links) => new ChainResolver(links);
const broken: MakeChain = (links) => new BrokenChain(links);

const A = callSite('a', 0);
const B = callSite('b', 1);
const C = callSite('c', 2);

async function failingCases(make: MakeChain): Promise<readonly string[]> {
  const failing: string[] = [];
  for (const c of CHAIN_CASES) {
    if ((await c.run(make)).length > 0) failing.push(c.id);
  }
  return failing;
}

describe('ChainResolver: the chain suite (INV-1, INV-4, INV-9, INV-10)', () => {
  it.each(CHAIN_CASES.map((c) => [`${c.id}: ${c.text}`, c] as const))('%s', async (_name, c) => {
    expect(await c.run(real)).toEqual([]);
  });

  it('the suite fails a deliberately broken chain on INV-4 and INV-10c, and only there', async () => {
    expect(await failingCases(broken)).toEqual(['INV-4a', 'INV-4b', 'INV-10c']);
  });

  it('INV-4: NullResolver declares no kind, so it never covers a host-accelerator link', () => {
    expect(
      () =>
        new ChainResolver([
          link('host', [], caps('host-accelerator', ['call'])),
          new NullResolver(),
        ]),
    ).toThrow(/^capability-parity:/);
  });
});

describe('ChainResolver: identity', () => {
  it('id is chain(<link ids joined by >)', () => {
    expect(new ChainResolver([link('l1', []), link('l2', []), new NullResolver()]).id).toBe(
      'chain(l1>l2>null)',
    );
    expect(new ChainResolver([]).id).toBe('chain()');
  });

  it.each([
    ['any checker link makes it checker', ['index', 'checker'], 'checker'],
    ['else the first link precision', ['index', 'syntactic'], 'index'],
    ['the first, not the most precise', ['syntactic', 'index'], 'syntactic'],
    ['no links: syntactic', [], 'syntactic'],
  ] as const)('precision: %s', (_name, precisions, expected) => {
    const links = precisions.map((precision, i) => link(`l${String(i)}`, [], { precision }));
    expect(new ChainResolver(links).precision).toBe(expected);
  });

  it('capabilities: union of extensions and kinds in first-seen order, the minimum maxConcurrentFiles', () => {
    const l1 = link('l1', [], {
      capabilities: { extensions: ['.py'], kinds: ['import', 'call'], maxConcurrentFiles: 4 },
    });
    const l2 = link('l2', [], {
      capabilities: {
        extensions: ['.pyi', '.py'],
        kinds: ['call', 'receiver'],
        maxConcurrentFiles: 2,
      },
    });
    expect(new ChainResolver([l1, l2, new NullResolver()]).capabilities).toEqual({
      extensions: ['.py', '.pyi'],
      kinds: ['import', 'call', 'receiver'],
      host: 'headless',
      maxConcurrentFiles: 2,
    });
  });

  it('capabilities: host-accelerator when any link is; no links declare nothing', () => {
    const host = link('host', [], {
      capabilities: { host: 'host-accelerator', kinds: ['call'], maxConcurrentFiles: 8 },
    });
    const py = link('py', [], { capabilities: { kinds: ['call'], maxConcurrentFiles: 3 } });
    expect(new ChainResolver([host, py]).capabilities).toEqual({
      extensions: ['.py'],
      kinds: ['call'],
      host: 'host-accelerator',
      maxConcurrentFiles: 3,
    });
    expect(new ChainResolver([]).capabilities).toEqual({
      extensions: [],
      kinds: [],
      host: 'headless',
      maxConcurrentFiles: Number.POSITIVE_INFINITY,
    });
  });
});

describe('ChainResolver: lifecycle', () => {
  it('open, fileChanged and close reach every link in order, each awaited before the next', async () => {
    const log: string[] = [];
    const l1 = link('l1', [], { log });
    const l2 = link('l2', [], { log });
    const chain = new ChainResolver([l1, l2]);
    await chain.open(WORKSPACE);
    await chain.fileChanged(FILE, 'x = 1\n');
    await chain.fileChanged(FILE, null);
    await chain.close();
    expect(log).toEqual([
      'l1 open',
      'l1 opened',
      'l2 open',
      'l2 opened',
      'l1 fileChanged m.py x = 1\n',
      'l1 fileChanged done',
      'l2 fileChanged m.py x = 1\n',
      'l2 fileChanged done',
      'l1 fileChanged m.py null',
      'l1 fileChanged done',
      'l2 fileChanged m.py null',
      'l2 fileChanged done',
      'l1 close',
      'l1 closed',
      'l2 close',
      'l2 closed',
    ]);
    expect(l1.workspaces).toEqual([WORKSPACE]);
    expect(l2.workspaces[0]).toBe(WORKSPACE);
  });

  it('INV-6: resolve before open rejects workspace-not-open and asks no link', async () => {
    const l1 = link('l1', [at(A, ans('resolved'))]);
    await expect(new ChainResolver([l1]).resolve(FILE, [A])).rejects.toThrow(/workspace-not-open/);
    expect(l1.calls).toEqual([]);
  });

  it('INV-6: resolve after close rejects workspace-not-open', async () => {
    const chain = new ChainResolver([link('l1', [])]);
    await chain.open(WORKSPACE);
    await chain.close();
    await expect(chain.resolve(FILE, [A])).rejects.toThrow(/workspace-not-open/);
  });
});

describe('ChainResolver: resolve', () => {
  it('passes the same ctx to every link it asks, and asks about open sites in ref order', async () => {
    const ctx: ResolveContext = {
      token: { isCancellationRequested: false },
      budget: { perSiteMs: 250, perFileMs: 500, warmupMs: 4000 },
    };
    const l1 = link('l1', [at(B, ans('resolved'))]);
    const l2 = link('l2', []);
    const chain = new ChainResolver([l1, l2]);
    await chain.open(WORKSPACE);
    await chain.resolve(FILE, [A, B, C], ctx);
    expect(l1.calls.map((c) => [c.filePath, c.refIds, c.ctx])).toEqual([
      [FILE, ['a', 'b', 'c'], ctx],
    ]);
    expect(l2.calls.map((c) => [c.filePath, c.refIds])).toEqual([[FILE, ['a', 'c']]]);
    expect(l2.calls[0]?.ctx).toBe(ctx);
  });

  it('no refs: no answers, no link asked', async () => {
    const l1 = link('l1', []);
    const chain = new ChainResolver([l1]);
    await chain.open(WORKSPACE);
    const batch = await chain.resolve(FILE, []);
    expect(batch.resolutions).toEqual([]);
    expect(l1.calls).toEqual([]);
    expect(batch.diagnostics).toStrictEqual({
      resolverId: 'chain(l1)',
      filePath: FILE,
      siteCount: 0,
      backend: 'ready',
      degraded: false,
      elapsedMs: 0,
      timedOutSites: 0,
    });
  });

  it('no links: every site unresolved no-resolver from the chain', async () => {
    const chain = new ChainResolver([]);
    await chain.open(WORKSPACE);
    const { resolutions } = await chain.resolve(FILE, [A, B]);
    expect(resolutions).toStrictEqual([
      {
        refId: 'a',
        status: 'unresolved',
        resolvedBy: 'chain()',
        confidence: 0,
        reason: 'no-resolver',
      },
      {
        refId: 'b',
        status: 'unresolved',
        resolvedBy: 'chain()',
        confidence: 0,
        reason: 'no-resolver',
      },
    ]);
  });

  it('keeps the winning answer whole: definition, target and confidence as the link gave them', async () => {
    const target = { fqn: '`d.py`/g().', filePath: FILE };
    const l1 = link('l1', [at(A, ans('unresolved', 'no-definition'))]);
    const l2 = link('l2', [at(A, { status: 'resolved', target, confidence: 0.6 })]);
    const chain = new ChainResolver([l1, l2]);
    await chain.open(WORKSPACE);
    const { resolutions } = await chain.resolve(FILE, [A]);
    expect(resolutions).toStrictEqual([
      { status: 'resolved', target, confidence: 0.6, refId: 'a', resolvedBy: 'l2' },
    ]);
  });

  it('INV-20: an already-cancelled token answers every site cancelled and asks no link', async () => {
    const l1 = link('l1', [at(A, ans('resolved'))]);
    const chain = new ChainResolver([l1]);
    await chain.open(WORKSPACE);
    const token: CancellationLike = { isCancellationRequested: true };
    const { resolutions } = await chain.resolve(FILE, [A, B], { token });
    expect(resolutions).toStrictEqual([
      {
        refId: 'a',
        status: 'unresolved',
        resolvedBy: 'chain(l1)',
        confidence: 0,
        reason: 'cancelled',
      },
      {
        refId: 'b',
        status: 'unresolved',
        resolvedBy: 'chain(l1)',
        confidence: 0,
        reason: 'cancelled',
      },
    ]);
    expect(l1.calls).toEqual([]);
  });

  it('INV-20: with no links, an already-cancelled token still answers cancelled', async () => {
    const chain = new ChainResolver([]);
    await chain.open(WORKSPACE);
    const { resolutions } = await chain.resolve(FILE, [A], {
      token: { isCancellationRequested: true },
    });
    expect(resolutions.map((r) => r.reason)).toEqual(['cancelled']);
  });

  it('INV-20: cancelled between links: no later link is asked, kept answers stand, the rest are cancelled', async () => {
    const token = { isCancellationRequested: false };
    const l1 = link('l1', [at(A, ans('dynamic')), at(B, ans('resolved'))], {
      during: () => {
        token.isCancellationRequested = true;
      },
      mangle: (rs) => rs.filter((r) => r.refId !== 'c'),
    });
    const l2 = link('l2', [at(A, ans('resolved')), at(C, ans('resolved'))]);
    const chain = new ChainResolver([l1, l2]);
    await chain.open(WORKSPACE);
    const { resolutions } = await chain.resolve(FILE, [A, B, C], { token });
    expect(resolutions.map((r) => [r.refId, r.status, r.resolvedBy, r.reason])).toEqual([
      ['a', 'dynamic', 'l1', undefined],
      ['b', 'resolved', 'l1', undefined],
      ['c', 'unresolved', 'chain(l1>l2)', 'cancelled'],
    ]);
    expect(l2.calls).toEqual([]);
  });
});

function backendLink(id: string, backend: BackendState): ReturnType<typeof link> {
  return link(id, [at(A, ans('unresolved', 'not-warm'))], { diagnostics: { backend } });
}

describe('ChainResolver: diagnostics and status', () => {
  it('sums elapsed and timed-out sites, ORs degraded, over the links asked', async () => {
    const l1 = link('l1', [at(A, ans('unresolved', 'timeout')), at(B, ans('resolved'))], {
      diagnostics: { backend: 'warming', degraded: false, elapsedMs: 3, timedOutSites: 1 },
    });
    const l2 = link('l2', [at(A, ans('unresolved', 'timeout'))], {
      diagnostics: { backend: 'ready', degraded: true, elapsedMs: 5, timedOutSites: 2 },
    });
    const chain = new ChainResolver([l1, l2]);
    await chain.open(WORKSPACE);
    const { diagnostics } = await chain.resolve(FILE, [A, B, C]);
    expect(diagnostics).toStrictEqual({
      resolverId: 'chain(l1>l2)',
      filePath: FILE,
      siteCount: 3,
      backend: 'warming',
      degraded: true,
      elapsedMs: 8,
      timedOutSites: 3,
    });
  });

  it('a link never asked adds nothing to the diagnostics', async () => {
    const l1 = link('l1', [at(A, ans('resolved'))], { diagnostics: { elapsedMs: 2 } });
    const l2 = link('l2', [], {
      diagnostics: { backend: 'degraded', degraded: true, elapsedMs: 9, timedOutSites: 4 },
    });
    const chain = new ChainResolver([l1, l2]);
    await chain.open(WORKSPACE);
    const { diagnostics } = await chain.resolve(FILE, [A]);
    expect(l2.calls).toEqual([]);
    expect([
      diagnostics.backend,
      diagnostics.degraded,
      diagnostics.elapsedMs,
      diagnostics.timedOutSites,
    ]).toEqual(['ready', false, 2, 0]);
  });

  it.each([
    ['ready', 'warming', 'warming'],
    ['starting', 'warming', 'starting'],
    ['starting', 'stopped', 'stopped'],
    ['degraded', 'stopped', 'degraded'],
  ] as const)(
    'backend: %s then %s is %s (ready < warming < starting < stopped < degraded)',
    async (b1, b2, expected) => {
      const chain = new ChainResolver([backendLink('l1', b1), backendLink('l2', b2)]);
      await chain.open(WORKSPACE);
      const { diagnostics } = await chain.resolve(FILE, [A]);
      expect(diagnostics.backend).toBe(expected);
    },
  );

  it('status(): worst state, summed restarts, the first lastError', () => {
    const l1 = link('l1', [], { status: { state: 'warming', restarts: 1 } });
    const l2 = link('l2', [], {
      status: { state: 'ready', restarts: 2, lastError: { message: 'boom' } },
    });
    const l3 = link('l3', [], {
      status: { state: 'starting', restarts: 0, lastError: { message: 'later' } },
    });
    expect(new ChainResolver([l1, l2, l3]).status()).toStrictEqual({
      resolverId: 'chain(l1>l2>l3)',
      state: 'starting',
      restarts: 3,
      lastError: { message: 'boom' },
    });
  });

  it('status(): with no link reporting an error there is no lastError; no links is ready', () => {
    const l1 = link('l1', [], { status: { state: 'degraded', restarts: 3 } });
    expect(new ChainResolver([l1]).status()).toStrictEqual({
      resolverId: 'chain(l1)',
      state: 'degraded',
      restarts: 3,
    });
    expect(new ChainResolver([]).status()).toStrictEqual({
      resolverId: 'chain()',
      state: 'ready',
      restarts: 0,
    });
  });
});
