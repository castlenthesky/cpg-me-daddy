/**
 * The differ M0.3's gate needs and nobody had scoped: the gate is stated as
 * change BETWEEN two versions of a file's id set ("insert above -> 0 id
 * changes", "rename -> exactly 1 delete + 1 create"), which means a test
 * needs to diff two id sets, not just compute one.
 */

export interface IdSetDiff {
  /** Ids present after but not before — sorted for a stable assertion. */
  readonly added: readonly string[];
  /** Ids present before but not after — sorted for a stable assertion. */
  readonly removed: readonly string[];
}

/** Diffs two node-id sets. Order-independent; duplicates in the input collapse. */
export function idSetDiff(before: readonly string[], after: readonly string[]): IdSetDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = [...afterSet].filter((id) => !beforeSet.has(id)).toSorted();
  const removed = [...beforeSet].filter((id) => !afterSet.has(id)).toSorted();
  return { added, removed };
}
