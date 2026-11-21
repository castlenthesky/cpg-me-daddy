# cpg

Code Property Graph for TypeScript/JavaScript/Python: an npm-workspaces TypeScript monorepo.
`packages/*` is core: `packages/model` (`@cpg/model`) is the real package. `apps/*` are front doors:
`apps/vscode` (`@cpg/vscode-host`) is the VS Code host; the extension manifest stays in the root `package.json`.

## Plan

- Read `docs/outline/README.md` first. `docs/outline/` is the only authoritative documentation; `docs/STATUS.md`, `docs/plans/` and `docs/research/` are historical: do not treat them as current.
- Never read the `docs/archive` branch, `archived/**`, or `.debate/`; they are retired history.
  If the outline lacks something you need, that is a defect in the outline — fix it there.
- Find work in `docs/outline/07-milestones.yaml`; check `02-decisions.yaml` before proposing changes.

## Commands (npm only)

| Command                    | What it does                                                                |
| -------------------------- | --------------------------------------------------------------------------- |
| `npm run check`            | THE gate: every fast check via turbo (cached). `verify` is an alias         |
| `npm run check:gates`      | Proves each gate fails on a planted violation (`-- --only-slow`: slow only) |
| `npm run format`           | oxfmt write                                                                 |
| `npm run format:check`     | oxfmt check                                                                 |
| `npm run lint`             | oxlint, type-aware, warnings denied (owns unused vars/params)               |
| `npm run lint:fix`         | oxlint autofix                                                              |
| `npm run typecheck`        | `tsc -b`                                                                    |
| `npm run typecheck:tests`  | `tsc` over all test files (incl. type tests)                                |
| `npm run check:deps`       | two-tier dependency rules (`tools/check-deps.mjs`)                          |
| `npm run check:pack`       | asserts what `npm pack` would ship                                          |
| `npm run knip`             | unused files/exports/deps                                                   |
| `npm test`                 | vitest (unit, property, type tests, `tools/*.test.mjs`)                     |
| `npm run test:coverage`    | vitest with coverage thresholds                                             |
| `npm run test:mutation`    | Stryker mutation testing (slow, not in `check`)                             |
| `npm run clean`            | SAFE FULL RESET: out, dist, tsbuildinfo, turbo, coverage, reports, stryker  |
| `npm run compile`/`watch`  | `tsc -b` / `tsc -b -w`                                                      |
| `npm run changeset`        | record a semver change for a package                                        |
| `npm run version-packages` | apply changesets (`changeset version`)                                      |

## Git hooks (lefthook)

- pre-commit: formats staged files with oxfmt and restages them, then runs oxlint and `check:deps`.
- pre-push: runs the full `npm run check`; it never skips.
- Emergency bypass only: `LEFTHOOK=0 git commit ...` (CI still runs every gate).

## Hard rules

- `packages/**` never imports a host SDK; `apps/<name>` imports only builtins, `@cpg/*` front doors and its own SDK (enforced by `tools/check-deps.mjs`).
- `@cpg/model` has ZERO runtime dependencies. Never add one (zod included).
- zod only at boundaries where outside data enters (config loader, MCP inputs). It arrives with its first consumer (U1 schema generator or U2 config loader).
- Unused variables/parameters are oxlint's job (tsc's noUnused* flags are off); prefix intentional ones with `_`.
- Every new gate needs a case in `tools/prove-gates.mjs` that plants a violation, with `expectOutput`. Slow cases get `slow: true` (skipped when `PROVE_GATES_SKIP_SLOW=1`, as in PR CI; the weekly mutation workflow runs them). A new `check-deps` rule gets its case in `tools/check-deps.test.mjs`.
- Build state lives inside the output dirs (`dist/.tsbuildinfo`); when anything build-related looks stale, run `npm run clean`.
- START SIMPLE. Do not generalize before the second concrete caller exists.
- Stub the whole shape first, compiling, each body labelled REAL, PASSTHROUGH or SEAT; then make one piece real at a time. Say which label a stub has, and never present a PASSTHROUGH or SEAT as working.
- The gate ships in the same PR as the code it gates. One unit, one branch, one PR, 200-500 reviewable lines.
- Do not restructure packages.

## Agent notes

- A PostToolUse hook (`tools/claude-post-edit.mjs`) formats each edited file and surfaces oxlint errors; fix them before moving on.
- Run `npm run check` before declaring any work done; CI is a second opinion.
