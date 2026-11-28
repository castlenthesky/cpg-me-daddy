// REAL (U6c.1a): the shared status rank and the one spelling of "couldn't answer".
import type { RefSite, Resolution, ResolutionReason, ResolutionStatus } from './contract';

const STATUS_RANK = { unresolved: 0, dynamic: 1, external: 2, ambiguous: 3, resolved: 4 } as const;

/**
 * C-RESOLVE shared_vocabulary.status_rank: unresolved 0, dynamic 1, external 2, ambiguous 3,
 * resolved 4. Rank <= 1 is OPEN (a chain asks the next link); rank >= 2 is an ANSWER (it stops).
 */
export function statusRank(status: ResolutionStatus): number {
  return STATUS_RANK[status];
}

/** `{ refId: ref.id, status: 'unresolved', resolvedBy, confidence: 0, reason }`, nothing else. */
export function unresolved(ref: RefSite, resolvedBy: string, reason: ResolutionReason): Resolution {
  return { refId: ref.id, status: 'unresolved', resolvedBy, confidence: 0, reason };
}
