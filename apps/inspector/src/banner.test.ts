// The #cpg-verification banner's text: the picture is labelled a liveness check, and the verify
// report sits beside it (BMO-35 line 5; 08-verification §3.3; C-EXT I-22 pushes every report). The
// format is design note 7's; the page sets it through textContent, so it is plain text.

import type { CheckResult, VerificationReport, VerifyCheckId } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { verificationText } from './banner';

const check = (id: VerifyCheckId, state: CheckResult['state']): CheckResult => ({
  id,
  state,
  observed: 1,
  expected: 2,
  localisedTo: ['src/a.ts'],
  detail: 'a detail the banner leaves out',
  asOfSeq: 3,
});

const SIX: readonly CheckResult[] = [
  check('filesystem-reconciliation', 'pass'),
  check('identity-invariants', 'unavailable'),
  check('id-uniqueness', 'pass'),
  check('render-reconciliation', 'fail'),
  check('revision-reconciliation', 'stale'),
  check('resolution-health', 'unavailable'),
];

const report = (
  seq: number,
  state: CheckResult['state'],
  checks: readonly CheckResult[],
): VerificationReport => ({
  epoch: 2,
  seq,
  state,
  checks,
});

describe('verificationText', () => {
  it('labels the picture a liveness check and lists all six checks in report order', () => {
    expect(verificationText(report(3, 'fail', SIX))).toBe(
      'Liveness check, not verification. Verify report at seq 3: fail. ' +
        'filesystem-reconciliation pass, identity-invariants unavailable, id-uniqueness pass, ' +
        'render-reconciliation fail, revision-reconciliation stale, resolution-health unavailable.',
    );
  });

  it('keeps the report order rather than sorting', () => {
    const reversed = SIX.toReversed();
    expect(verificationText(report(0, 'fail', reversed.slice(0, 2)))).toBe(
      'Liveness check, not verification. Verify report at seq 0: fail. ' +
        'resolution-health unavailable, revision-reconciliation stale.',
    );
  });

  it('ends after the state when the report has no checks', () => {
    expect(verificationText(report(12, 'unavailable', []))).toBe(
      'Liveness check, not verification. Verify report at seq 12: unavailable.',
    );
  });

  it('shows a passing report as pass, still labelled a liveness check', () => {
    expect(verificationText(report(1, 'pass', [check('id-uniqueness', 'pass')]))).toBe(
      'Liveness check, not verification. Verify report at seq 1: pass. id-uniqueness pass.',
    );
  });
});
