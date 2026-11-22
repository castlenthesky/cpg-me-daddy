import { describe, expect, it } from 'vitest';
import * as contract from './contract';
import * as api from './index';

// SEAT package, types only until its implementation unit: neither the front door nor contract.ts may
// carry a runtime export (check-deps rule 7 limits imports only, so this is the export-side guard).
describe('@cpg/resolve is types only', () => {
  it.each([
    ['index', api],
    ['contract', contract],
  ])('%s has no runtime exports', (_name, ns) => {
    expect(Object.keys(ns)).toEqual([]);
  });
});
