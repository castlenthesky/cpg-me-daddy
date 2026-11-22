// cpg verify's six checks (C-CLI VerifyReport, 08-verification.md §3, BMO-80).

import type { CheckState } from './port';

/** The worst of `states`: fail > stale > unavailable > pass; `pass` when empty. */
export function worstState(_states: readonly CheckState[]): CheckState {
  // SEAT: U2a.3
  throw new Error('SEAT: worstState lands with U2a.3');
}
