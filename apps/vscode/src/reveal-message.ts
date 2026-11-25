// SEAT (U3.1.1 part 4, BMO-52): what the editor says about a reveal (controller decision 37).

import type { RevealOutcome } from './contract';

/**
 * The message for an outcome, or undefined for an `ok` one:
 * - `unknown-node`: `CPG: the graph has no node <id>`;
 * - `no-location`: `CPG: <id> has no source location to open`;
 * - `open-failed`: `CPG: cannot open <path>: <error message>`.
 */
export function revealMessage(_outcome: RevealOutcome): string | undefined {
  throw new Error('SEAT: revealMessage (U3.1.1 part 4)');
}
