/**
 * Content hashing (M0.2). `FILE.content_hash`'s declared meaning is "SHA-256
 * of file bytes" (schema/nodes.ts) — hashed here from the raw `Buffer`, not
 * the decoded string, so a CRLF/LF-only change is correctly seen as a change.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { type FileEntry, type WalkOptions, walkWorkspace } from "./walker";

/** Lowercase hex SHA-256 of `bytes`. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface FileRecord extends FileEntry {
  /** 64-character lowercase hex SHA-256 of the file's raw bytes. */
  readonly contentHash: string;
  readonly loc: number;
}

export interface LoadedFile {
  readonly record: FileRecord;
  readonly text: string;
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* "\n" */) {
      lines++;
    }
  }
  return lines;
}

/**
 * A deterministic FalkorDB graph key derived from a workspace's absolute
 * root path — `cpg_<12 hex chars of SHA-256(root)>`. Node ids are
 * workspace-*relative*, so two different workspace roots sharing one graph
 * key would collide: the second workspace's own scope-delete
 * (`store/cypher.ts`'s `planDelta`) would silently wipe the first
 * workspace's nodes, since e.g. `src/index.ts` in two repos produces
 * byte-identical ids. This is only the DEFAULT — an explicit `--graph` /
 * `CPG_GRAPH` / `cpg.engine.db.graph` still overrides it (see
 * `store/falkordb.config.ts`'s `defineCpgFalkorConfig` doc on `defaults` vs.
 * an override).
 *
 * Hashes the resolved path string, not a symlink-canonicalized `realpath` —
 * a workspace opened through two different symlinks to the same real
 * directory gets two different keys. Accepted: canonicalizing needs an
 * async `fs.realpath` call, and `defineCpgConfig` is synchronous.
 *
 * Hex digits are never `t` or `s`, so the result can never start with
 * `cpg_test_` — `assertNotTestHarness` (`store/open.ts`) stays satisfied
 * without a special case here.
 */
export function workspaceGraphKey(root: string): string {
  return `cpg_${hashBytes(Buffer.from(root, "utf8")).slice(0, 12)}`;
}

/**
 * Reads `entry` once, producing both the decoded text an extractor needs and
 * the `FileRecord` a FILE node is built from — one read, not two.
 */
export async function loadFile(entry: FileEntry): Promise<LoadedFile> {
  const bytes = await readFile(entry.absolutePath);
  const contentHash = hashBytes(bytes);
  const text = bytes.toString("utf8");
  const record: FileRecord = { ...entry, contentHash, loc: countLines(text) };
  return { record, text };
}

/**
 * Walks `options`, then hashes every file found — the "emit the file record
 * set" M0.2 promises, on its own, with no indexer involved. `text` is
 * dropped; call `loadFile` directly when the decoded source is also needed.
 */
export async function collectFileRecords(options: WalkOptions): Promise<readonly FileRecord[]> {
  const { files } = await walkWorkspace(options);
  const loaded = await Promise.all(files.map((file) => loadFile(file)));
  return loaded.map((l) => l.record);
}
