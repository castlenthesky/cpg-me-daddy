import { describe, expect, it } from 'vitest';
import * as contract from './contract';
import * as api from './index';

// contract.ts stays types only (check-deps rule 7 limits its imports; this guards its exports). Nothing
// in @cpg/extract runs yet (U6a.2-1), so the front door exports no runtime value either.
describe('@cpg/extract front door', () => {
  it('contract.ts has no runtime exports', () => {
    expect(Object.keys(contract)).toEqual([]);
  });

  it('index exports no runtime value until the extractor lands (U6a.2-2)', () => {
    expect(Object.keys(api)).toEqual([]);
  });
});
