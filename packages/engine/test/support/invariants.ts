/**
 * Graph invariants — verification spine layer VS3.
 *
 * Ported from `globalInvariants()` in ast-demo/bench/src/verify.ts (survey
 * finding SF3), where these checks ran only inside the benchmark. They are now
 * a standing gate: every integration test ends by asserting them, so a change
 * that corrupts the graph fails the suite that made the change rather than the
 * next person's.
 *
 * The three properties, and why each one matters:
 *
 *   duplicate SYMBOL fqns  A fully-qualified name is the join key the whole
 *                          graph resolves CALLS through. Two SYMBOLs sharing
 *                          one fqn means an incremental replace inserted
 *                          instead of merging, and every later lookup silently
 *                          picks one arbitrarily.
 *   orphan SYMBOLs         A SYMBOL nothing points at is garbage a replace
 *                          failed to collect. Harmless to read, but it grows
 *                          without bound and makes fqn collisions likelier.
 *   non-ready FILEs        A FILE is flipped out of `ready` for the duration of
 *                          its replace. One left behind means a replace died
 *                          mid-flight and that file's slice of the graph is
 *                          torn.
 */

import type { Client } from "../../src/store/client.ts";

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

/** Runs the three global checks and reports every problem, not just the first. */
export async function checkGraphInvariants(client: Client): Promise<VerifyResult> {
  const problems: string[] = [];

  const dup = await client.scalar(
    "MATCH (s:SYMBOL) WITH s.fqn AS f, count(*) AS c WHERE c > 1 RETURN count(*) AS n",
  );
  if (dup !== 0) {
    const names = await client.read<{ f: string; c: number }>(
      "MATCH (s:SYMBOL) WITH s.fqn AS f, count(*) AS c WHERE c > 1 RETURN f, c ORDER BY f LIMIT 10",
    );
    const detail = names.data.map((r) => `${r.f} x${r.c}`).join(", ");
    problems.push(`${dup} duplicate SYMBOL fqn(s): ${detail}`);
  }

  const orphans = await client.scalar("MATCH (s:SYMBOL) WHERE NOT (s)<-[]-() RETURN count(s) AS n");
  if (orphans !== 0) {
    const names = await client.read<{ f: string }>(
      "MATCH (s:SYMBOL) WHERE NOT (s)<-[]-() RETURN s.fqn AS f ORDER BY f LIMIT 10",
    );
    const detail = names.data.map((r) => r.f).join(", ");
    problems.push(`${orphans} orphan SYMBOL(s) globally: ${detail}`);
  }

  const nonReady = await client.scalar(
    "MATCH (f:FILE) WHERE f.status <> 'ready' RETURN count(f) AS n",
  );
  if (nonReady !== 0) {
    const names = await client.read<{ p: string; s: string }>(
      "MATCH (f:FILE) WHERE f.status <> 'ready' RETURN f.path AS p, f.status AS s ORDER BY p LIMIT 10",
    );
    const detail = names.data.map((r) => `${r.p}=${r.s}`).join(", ");
    problems.push(`${nonReady} FILE(s) left in non-ready status: ${detail}`);
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Throws unless the graph satisfies every global invariant. The thrown message
 * lists all problems at once so one run tells you everything that is wrong.
 */
export async function assertGraphInvariants(client: Client): Promise<void> {
  const result = await checkGraphInvariants(client);
  if (!result.ok) {
    const lines = result.problems.map((p) => `  - ${p}`).join("\n");
    throw new Error(`Graph invariants violated in "${client.graphName}":\n${lines}`);
  }
}
