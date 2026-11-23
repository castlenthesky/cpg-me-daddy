// REAL (U2b.1 part 3a-i, BMO-35): the #cpg-verification banner's text (BMO-35 line 5; 08-verification
// §3.3: the graph is never shown without its verdict).

import type { VerificationReport } from '@cpg/model';

/**
 * Plain text for textContent: `Liveness check, not verification. Verify report at seq <seq>: <state>.`
 * then, when there are checks, a space and each check in report order as `<id> <state>`, joined by
 * `, ` and ended with `.`.
 */
export function verificationText(report: VerificationReport): string {
  const head = `Liveness check, not verification. Verify report at seq ${report.seq}: ${report.state}.`;
  if (report.checks.length === 0) return head;
  const checks = report.checks.map((check) => `${check.id} ${check.state}`).join(', ');
  return `${head} ${checks}.`;
}
