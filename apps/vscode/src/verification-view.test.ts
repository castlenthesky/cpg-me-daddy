// A verify report as data for the status bar and the diagnostics (08-verification §3.3: "a status-bar
// glyph (worst state plus failing count) and a DiagnosticCollection('cpg') entry on each offending
// file"). Expected values come from there and from the doc comments.

import {
  isWorkspacePath,
  makeNodeId,
  type CheckResult,
  type CheckState,
  type VerificationReport,
  type VerifyCheckId,
} from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { statusBarView, verificationDiagnostics, verificationStatus } from './verification-view';

const IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];

/** All six checks passing, except those in `over`. */
function report(
  state: CheckState,
  over: Partial<Record<VerifyCheckId, Partial<CheckResult>>> = {},
): VerificationReport {
  return {
    epoch: 1,
    seq: 4,
    state,
    checks: IDS.map((id) => ({
      id,
      state: 'pass',
      observed: 1,
      expected: 1,
      localisedTo: [],
      asOfSeq: 4,
      ...over[id],
    })),
  };
}

const path = (value: string) => {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
};

describe('verificationStatus: one glyph for the worst state, and the failing count', () => {
  it.each([
    ['pass', 'check'],
    ['fail', 'error'],
    ['stale', 'history'],
    ['unavailable', 'question'],
  ] as const)('%s is %s', (state, glyph) => {
    expect(verificationStatus(report(state))).toStrictEqual({ state, glyph, failing: 0 });
  });

  it('counts the failing checks only: stale and unavailable are not failures', () => {
    const mixed = report('fail', {
      'filesystem-reconciliation': { state: 'fail' },
      'identity-invariants': { state: 'unavailable' },
      'render-reconciliation': { state: 'stale' },
      'revision-reconciliation': { state: 'fail', localisedTo: ['a.ts', 'b.ts', 'c.ts'] },
      'resolution-health': { state: 'unavailable' },
    });
    expect(verificationStatus(mixed)).toStrictEqual({ state: 'fail', glyph: 'error', failing: 2 });
  });

  it('shows the state the report says, the worst of the six', () => {
    const stale = report('stale', { 'render-reconciliation': { state: 'stale' } });
    expect(verificationStatus(stale)).toStrictEqual({
      state: 'stale',
      glyph: 'history',
      failing: 0,
    });
  });
});

describe('verificationDiagnostics: each offender on the file it is in', () => {
  it('revision-reconciliation names files: one entry each, in order, with the check and its detail', () => {
    const stale = report('fail', {
      'revision-reconciliation': {
        state: 'fail',
        // Round two (review a10): the order is localisedTo's, not sorted.
        localisedTo: ['src/odd:%name.ts', 'src/a.ts'],
        detail: '2 revision mismatches',
      },
    });
    const entry = {
      checkId: 'revision-reconciliation',
      message: 'revision-reconciliation: 2 revision mismatches',
    };
    expect(verificationDiagnostics(stale)).toStrictEqual([
      { ...entry, filePath: 'src/odd:%name.ts' },
      { ...entry, filePath: 'src/a.ts' },
    ]);
  });

  it.each(['id-uniqueness', 'render-reconciliation'] as const)(
    '%s names node ids: each on the file its id is addressed in, escapes undone, naming the id',
    (checkId) => {
      const fileId = makeNodeId({ form: 'file', path: path('src/odd:%name.ts') });
      const methodId = makeNodeId({
        form: 'scoped',
        path: path('src/a.ts'),
        kind: 'METHOD',
        scope: ['C', 'm'],
      });
      const made = verificationDiagnostics(
        report('fail', {
          [checkId]: { state: 'fail', localisedTo: [methodId, fileId], detail: 'two of them' },
        }),
      );
      expect(made).toStrictEqual([
        { filePath: 'src/a.ts', checkId, message: `${checkId}: two of them (${methodId})` },
        { filePath: 'src/odd:%name.ts', checkId, message: `${checkId}: two of them (${fileId})` },
      ]);
    },
  );

  it('has no entry for what is not inside a file', () => {
    const made = verificationDiagnostics(
      report('fail', {
        'filesystem-reconciliation': { state: 'fail', localisedTo: ['.', 'src'], detail: 'd' },
        // Round two (review b1, a8): no offenders before U6c, and ids parseNodeId refuses.
        'identity-invariants': { state: 'fail', localisedTo: ['file:a.ts', 'a.ts'] },
        'resolution-health': { state: 'fail', localisedTo: ['file:a.ts', 'a.ts'] },
        'render-reconciliation': {
          state: 'fail',
          localisedTo: ['file:.', 'file:../x', 'file:a.ts:bad', 'file:a%2Fb.ts', 'file:'],
        },
        'id-uniqueness': { state: 'fail', localisedTo: ['dir:src', 'sym', 'file:b.ts'] },
        'revision-reconciliation': { state: 'fail', localisedTo: ['.', '../x', '/abs', 'c.ts'] },
      }),
    );
    expect(made.map((entry) => entry.filePath)).toEqual(['b.ts', 'c.ts']);
  });

  it('follows the report order across checks; a check with no detail says its state', () => {
    const made = verificationDiagnostics(
      report('fail', {
        'id-uniqueness': { state: 'fail', localisedTo: ['file:z.ts'] },
        'render-reconciliation': { state: 'fail', localisedTo: ['file:y.ts'], detail: 'd' },
        // Round two (review a9): the state that stands in is the check's own.
        'revision-reconciliation': { state: 'stale', localisedTo: ['a.ts'] },
      }),
    );
    expect(made.map((entry) => entry.message)).toEqual([
      'id-uniqueness: fail (file:z.ts)',
      'render-reconciliation: d (file:y.ts)',
      'revision-reconciliation: stale',
    ]);
  });

  it('a report with no offenders has none', () => {
    expect(verificationDiagnostics(report('pass'))).toEqual([]);
  });
});

describe('statusBarView: the glyph and the failing count, with every check in the tooltip', () => {
  it.each([
    ['pass', '$(check) CPG'],
    ['stale', '$(history) CPG'],
    ['unavailable', '$(question) CPG'],
  ] as const)('%s', (state, text) => {
    expect(statusBarView(report(state)).text).toBe(text);
  });

  it('counts the failing checks, and says why each is what it is', () => {
    const mixed = report('fail', {
      'filesystem-reconciliation': { state: 'fail', detail: 'sources differ' },
      'identity-invariants': { state: 'unavailable', detail: 'until U6c' },
      'revision-reconciliation': { state: 'fail' },
    });
    expect(statusBarView(mixed)).toStrictEqual({
      text: '$(error) CPG 2',
      tooltip: [
        'CPG verify at seq 4: fail',
        'filesystem-reconciliation: fail: sources differ',
        'identity-invariants: unavailable: until U6c',
        'id-uniqueness: pass',
        'render-reconciliation: pass',
        'revision-reconciliation: fail',
        'resolution-health: pass',
      ].join('\n'),
    });
  });
});
