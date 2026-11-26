import { describe, expect, it } from 'vitest';
import * as contract from './contract';
import * as api from './index';

// contract.ts stays types only (check-deps rule 7 limits its imports; this guards its exports). The
// front door exports exactly the runtime values that are REAL today.
describe('@cpg/watch front door', () => {
  it('contract.ts has no runtime exports', () => {
    expect(Object.keys(contract)).toEqual([]);
  });

  it('index exports the backend, coalesce, the batcher, pairing, the queue and the session, and nothing else', () => {
    expect(Object.keys(api).toSorted()).toEqual([
      'ChangeBatcher',
      'SerialQueue',
      'coalesce',
      'createParcelWatchBackend',
      'createWatchSession',
      'flushBatch',
      'isExcludedPath',
      'pairFileRenames',
      'withRetry',
    ]);
  });
});
