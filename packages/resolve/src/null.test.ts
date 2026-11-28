import { describe, expect, it } from 'vitest';
import { callSite, FILE, WORKSPACE } from '../test/chain-contract';
import { NullResolver } from './null';

const A = callSite('a', 0);
const B = callSite('b', 1);
const C = callSite('c', 2);

const noResolver = (refId: string) => ({
  refId,
  status: 'unresolved',
  resolvedBy: 'null',
  confidence: 0,
  reason: 'no-resolver',
});

describe('NullResolver (PASSTHROUGH: the control that resolves nothing)', () => {
  it('declares no extension and no kind, so it can never satisfy capability parity', () => {
    const r = new NullResolver();
    expect([r.id, r.precision]).toEqual(['null', 'syntactic']);
    expect(r.capabilities).toEqual({
      extensions: [],
      kinds: [],
      host: 'headless',
      maxConcurrentFiles: Number.POSITIVE_INFINITY,
    });
  });

  it('INV-1 and INV-14: one unresolved no-resolver answer per ref, in order, nothing else', async () => {
    const r = new NullResolver();
    await r.open(WORKSPACE);
    const batch = await r.resolve(FILE, [B, A, C]);
    expect(batch.resolutions).toStrictEqual([noResolver('b'), noResolver('a'), noResolver('c')]);
    expect(batch.diagnostics).toStrictEqual({
      resolverId: 'null',
      filePath: FILE,
      siteCount: 3,
      backend: 'ready',
      degraded: false,
      elapsedMs: 0,
      timedOutSites: 0,
    });
  });

  it('INV-6: resolve before open rejects workspace-not-open', async () => {
    await expect(new NullResolver().resolve(FILE, [A])).rejects.toThrow(/workspace-not-open/);
  });

  it('INV-6: resolve after close rejects workspace-not-open', async () => {
    const r = new NullResolver();
    await r.open(WORKSPACE);
    await r.close();
    await expect(r.resolve(FILE, [A])).rejects.toThrow(/workspace-not-open/);
  });

  it('INV-20: an already-cancelled token answers every site cancelled', async () => {
    const r = new NullResolver();
    await r.open(WORKSPACE);
    const { resolutions } = await r.resolve(FILE, [A, B], {
      token: { isCancellationRequested: true },
    });
    expect(resolutions).toStrictEqual([
      { ...noResolver('a'), reason: 'cancelled' },
      { ...noResolver('b'), reason: 'cancelled' },
    ]);
  });

  it('INV-20: a token that is not cancelled changes nothing', async () => {
    const r = new NullResolver();
    await r.open(WORKSPACE);
    const { resolutions } = await r.resolve(FILE, [A], {
      token: { isCancellationRequested: false },
    });
    expect(resolutions).toStrictEqual([noResolver('a')]);
  });

  it('status(): stopped until open, ready while open, stopped after close; never restarts', async () => {
    const r = new NullResolver();
    const stopped = { resolverId: 'null', state: 'stopped', restarts: 0 };
    expect(r.status()).toStrictEqual(stopped);
    await r.open(WORKSPACE);
    await r.fileChanged(FILE, 'x = 1\n');
    await r.fileChanged(FILE, null);
    expect(r.status()).toStrictEqual({ ...stopped, state: 'ready' });
    await r.close();
    expect(r.status()).toStrictEqual(stopped);
  });
});
