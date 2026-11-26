// REAL (U3.1.1 part 4, BMO-52): what the editor says about a reveal (controller decision 37).

import type { RevealOutcome } from './contract';

/**
 * The message for an outcome, or undefined for an `ok` one:
 * - `unknown-node`: `CPG: the graph has no node <id>`;
 * - `no-location`: `CPG: <id> has no source location to open`;
 * - `open-failed`: `CPG: cannot open <path>: <error message>`.
 */
export function revealMessage(outcome: RevealOutcome): string | undefined {
  if (outcome.ok) return undefined;
  if (outcome.reason === 'unknown-node') return `CPG: the graph has no node ${outcome.nodeId}`;
  if (outcome.reason === 'no-location') {
    return `CPG: ${outcome.nodeId} has no source location to open`;
  }
  return `CPG: cannot open ${outcome.filePath}: ${outcome.error.message}`;
}
