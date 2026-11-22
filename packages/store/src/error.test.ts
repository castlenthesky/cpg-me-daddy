import { describe, expect, it } from 'vitest';
import { storeError, storeErrorCode } from './error';

describe('storeError / storeErrorCode', () => {
  it('builds an Error named StoreError carrying its code', () => {
    const e = storeError('STORE_NOT_OPEN', 'open() first');
    expect(e).toBeInstanceOf(Error);
    expect([e.name, e.code, e.message]).toEqual(['StoreError', 'STORE_NOT_OPEN', 'open() first']);
    expect(storeErrorCode(e)).toBe('STORE_NOT_OPEN');
  });

  it.each([
    ['a plain Error', new Error('x')],
    ['a look-alike with an unknown code', { name: 'StoreError', code: 'NOPE' }],
    ['a code without the name', { code: 'CAPACITY' }],
    ['null', null],
    ['a string', 'STORE_NOT_OPEN'],
  ])('reads %s as no StoreError', (_label, value) => {
    expect(storeErrorCode(value)).toBeUndefined();
  });
});
