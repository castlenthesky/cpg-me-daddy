/**
 * The M0.1-thin subset: resolve includes/excludes and a DB target, nothing
 * more. No `cpg.config.yaml` parsing, no manifest discovery (package.json
 * workspaces / pyproject / uv / tsconfig references), no `.gitignore` merge,
 * no `cpg doctor`, no CLI > env > file > manifest > defaults precedence
 * layering. That is M0.1-full's job, and its seam is exactly this function's
 * `input`: a loader that resolves a `cpg.config.yaml` plus the CLI flags and
 * env into one `CpgConfigInput` and hands it to `defineCpgConfig` unchanged.
 * Until that loader exists, a caller (the CLI, the extension) builds the
 * input directly from its own flags/settings.
 */
import { resolve } from "node:path";

import type { FalkorConfig, FalkorConfigInput } from "falkordb-service";

import { defineCpgDevFalkorConfig } from "../store/falkordb.config";
import {
  DEFAULT_EXCLUDES,
  DEFAULT_INCLUDES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
} from "../workspace/defaults";
import type { WalkOptions } from "../workspace/walker";

export interface CpgConfigInput {
  /** Workspace root. Default `process.cwd()`. Resolved to an absolute path. */
  readonly root?: string;
  /** Replaces `DEFAULT_INCLUDES` entirely. */
  readonly include?: readonly string[];
  /** Replaces `DEFAULT_EXCLUDES` entirely. Use `excludeExtra` to add instead of replace. */
  readonly exclude?: readonly string[];
  /** Appended to whichever exclude set is in force (`exclude`, if given, else `DEFAULT_EXCLUDES`). */
  readonly excludeExtra?: readonly string[];
  readonly maxFileSizeBytes?: number;
  readonly followSymlinks?: boolean;
  /** Passed straight through to `defineCpgDevFalkorConfig`. */
  readonly db?: FalkorConfigInput;
  /** Env source for both the walk config and (unless `db.env` overrides it) the DB config. Defaults to `process.env`; injected in tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CpgConfig {
  readonly root: string;
  readonly walk: WalkOptions;
  readonly falkor: FalkorConfig;
}

/** Resolves `input` into a `WalkOptions` and a `FalkorConfig` — nothing else. */
export function defineCpgConfig(input: CpgConfigInput = {}): CpgConfig {
  const root = resolve(input.root ?? process.cwd());
  const exclude = [...(input.exclude ?? DEFAULT_EXCLUDES), ...(input.excludeExtra ?? [])];

  const walk: WalkOptions = {
    root,
    include: input.include ?? DEFAULT_INCLUDES,
    exclude,
    maxFileSizeBytes: input.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    followSymlinks: input.followSymlinks ?? false,
  };

  const falkor = defineCpgDevFalkorConfig({ env: input.env, ...input.db });

  return { root, walk, falkor };
}
