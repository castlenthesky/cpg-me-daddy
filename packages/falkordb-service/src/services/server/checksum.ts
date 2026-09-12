/** SHA-256 verification of a cached artefact. Nothing launches unverified. */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streaming sha256 so a 50 MB module never lands in memory twice. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export interface ChecksumResult {
  ok: boolean;
  expected: string;
  actual: string;
}

/** Case-insensitive hex comparison against the pinned manifest value. */
export async function verifyChecksum(path: string, expected: string): Promise<ChecksumResult> {
  const actual = await sha256File(path);
  return { ok: actual.toLowerCase() === expected.toLowerCase(), expected, actual };
}
