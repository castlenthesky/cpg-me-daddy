// C-PARSE I13 and DEFECT-ABI-VACUOUS. Every grammar v1 ships is inside the runtime's range, so the
// failure paths are driven through the ParserRuntime seam with chosen numbers (controller decision 99).
import { describe, expect, it } from 'vitest';
import { AbiNotReadyError, checkGrammarAbi, createAbiGate, type ParserRuntime } from './abi';

type Bindings = ReturnType<ParserRuntime['abiBindings']>;
// web-tree-sitter 0.27.0's measured range (C-PARSE pinned abi_range "13–15").
const RANGE = { minCompatible: 13, languageVersion: 15 };
const UNSET: Bindings = { minCompatible: undefined, languageVersion: undefined };
const BOOM = new Error('no wasm runtime');

const runtime = (
  bindings: Bindings,
  init = (): Promise<void> => Promise.resolve(),
): ParserRuntime => ({
  init,
  abiBindings: () => bindings,
});

async function opened(bindings: Bindings) {
  const gate = createAbiGate(runtime(bindings));
  await gate.init();
  return gate.range();
}

describe('the gate opens only when init resolves (I13)', () => {
  it('throws AbiNotReadyError before init and while init is pending', async () => {
    expect(() => createAbiGate(runtime(RANGE)).range()).toThrow(AbiNotReadyError);
    let finish: (() => void) | undefined;
    const gate = createAbiGate(runtime(RANGE, () => new Promise<void>((r) => (finish = r))));
    const pending = gate.init();
    expect(() => gate.range()).toThrow(AbiNotReadyError);
    finish?.();
    await pending;
    expect(gate.range()).toEqual({ ok: true, range: RANGE });
  });

  it('a rejected init propagates and leaves the gate shut; a later init that resolves opens it', async () => {
    let failures = 1;
    const gate = createAbiGate(
      runtime(RANGE, () => (failures-- > 0 ? Promise.reject(BOOM) : Promise.resolve())),
    );
    await expect(gate.init()).rejects.toBe(BOOM);
    expect(() => gate.range()).toThrow(AbiNotReadyError);
    await gate.init();
    expect(gate.range()).toEqual({ ok: true, range: RANGE });
    failures = 1;
    await expect(gate.init()).rejects.toBe(BOOM);
    expect(gate.range()).toEqual({ ok: true, range: RANGE });
  });

  it('reads the bindings when asked, not when built: init is what sets them', async () => {
    let bindings = UNSET;
    const gate = createAbiGate({
      init: async () => {
        await Promise.resolve();
        bindings = RANGE;
      },
      abiBindings: () => bindings,
    });
    await gate.init();
    expect(gate.range()).toEqual({ ok: true, range: RANGE });
  });

  it('names itself, so a caller can tell it from an outcome', () => {
    expect(new AbiNotReadyError()).toMatchObject({ name: 'AbiNotReadyError' });
  });
});

describe('an unreadable range is an error, never a skipped check (I13)', () => {
  it.each([
    ['both undefined', UNSET],
    ['languageVersion undefined', { minCompatible: 13, languageVersion: undefined }],
    ['minCompatible undefined', { minCompatible: undefined, languageVersion: 15 }],
    ['NaN', { minCompatible: Number.NaN, languageVersion: 15 }],
    ['fractional', { minCompatible: 13, languageVersion: 14.5 }],
    ['zero', { minCompatible: 0, languageVersion: 15 }],
    ['negative', { minCompatible: -1, languageVersion: 15 }],
    ['inverted', { minCompatible: 15, languageVersion: 13 }],
  ])('%s is ok:false', async (_name, bindings) => {
    expect(await opened(bindings)).toEqual({ ok: false, message: expect.any(String) });
  });

  it('a one-version range is a range', async () => {
    const single = { minCompatible: 14, languageVersion: 14 };
    expect(await opened(single)).toEqual({ ok: true, range: single });
  });
});

describe('checkGrammarAbi', () => {
  it.each([13, 14, 15])('ABI %i is inside 13..15 (inclusive at both ends)', (abi) => {
    expect(checkGrammarAbi(abi, RANGE)).toBeUndefined();
  });

  it('an ABI below the range is too old and above it too new, naming the version and the range', () => {
    const old = checkGrammarAbi(12, RANGE);
    const future = checkGrammarAbi(16, RANGE);
    expect([old?.includes('too old'), old?.includes('12'), old?.includes('13..15')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([
      future?.includes('too new'),
      future?.includes('16'),
      future?.includes('13..15'),
    ]).toEqual([true, true, true]);
  });

  // NaN and 14.5 compare false against both bounds: an unguarded check would pass them.
  it.each([Number.NaN, 14.5, 0, -1])('ABI %d is not a version, so it is outside', (abi) => {
    expect(checkGrammarAbi(abi, RANGE)).toEqual(expect.any(String));
  });
});
