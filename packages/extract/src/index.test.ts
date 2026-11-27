import { describe, expect, it } from 'vitest';
import * as contract from './contract';
import * as api from './index';

// contract.ts stays types only (check-deps rule 7 limits its imports; this guards its exports). The
// front door exports the extractor and the seal, and nothing else (the builder, the digests and the
// adapters are internal).
describe('@cpg/extract front door', () => {
  it('contract.ts has no runtime exports', () => {
    expect(Object.keys(contract)).toEqual([]);
  });

  it('index exports createExtractor and sealExtractedFiles only', () => {
    expect(Object.keys(api).toSorted()).toEqual(['createExtractor', 'sealExtractedFiles']);
  });
});
