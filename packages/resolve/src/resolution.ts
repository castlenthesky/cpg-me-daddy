// SEAT (U6c.1a): the shared status rank and the one spelling of "couldn't answer".
import type { RefSite, Resolution, ResolutionReason, ResolutionStatus } from './contract';

/**
 * C-RESOLVE shared_vocabulary.status_rank: unresolved 0, dynamic 1, external 2, ambiguous 3,
 * resolved 4. Rank <= 1 is OPEN (a chain asks the next link); rank >= 2 is an ANSWER (it stops).
 */
export function statusRank(_status: ResolutionStatus): number {
  throw new Error('SEAT: statusRank lands in U6c.1a');
}

/** `{ refId: ref.id, status: 'unresolved', resolvedBy, confidence: 0, reason }`, nothing else. */
export function unresolved(
  _ref: RefSite,
  _resolvedBy: string,
  _reason: ResolutionReason,
): Resolution {
  throw new Error('SEAT: unresolved lands in U6c.1a');
}
