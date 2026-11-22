import { describe, expect, it } from 'vitest';
import * as contract from './contract';
import * as api from './index';

// contract.ts stays types only (check-deps rule 7 limits its imports; this guards its exports), and
// the front door exports exactly the runtime values that are REAL today.
describe('@cpg/parse front door', () => {
  it('contract.ts has no runtime exports', () => {
    expect(Object.keys(contract)).toEqual([]);
  });

  it('index exports the registry and nothing else at runtime', () => {
    expect(new Set(Object.keys(api))).toEqual(
      new Set(['BUILTIN_LANGUAGES', 'createLanguageRegistry']),
    );
  });
});
