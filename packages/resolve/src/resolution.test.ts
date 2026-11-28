import { describe, expect, it } from 'vitest';
import { callSite } from '../test/chain-contract';
import { statusRank, unresolved } from './resolution';

describe('resolution helpers', () => {
  it('unresolved(): the one spelling of "could not answer", with no definition or target', () => {
    expect(unresolved(callSite('s1', 3), 'python-path', 'module-not-found')).toStrictEqual({
      refId: 's1',
      status: 'unresolved',
      resolvedBy: 'python-path',
      confidence: 0,
      reason: 'module-not-found',
    });
  });

  it('statusRank: shared_vocabulary.status_rank', () => {
    const statuses = ['unresolved', 'dynamic', 'external', 'ambiguous', 'resolved'] as const;
    expect(statuses.map((s) => statusRank(s))).toEqual([0, 1, 2, 3, 4]);
  });
});
