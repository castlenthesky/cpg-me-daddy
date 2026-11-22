# cpg

Code Property Graph for TypeScript/JavaScript/Python: a bun-workspaces TypeScript monorepo.
`packages/model` (`@cpg/model`) is the real package; `src/extension.ts` is the VS Code host (moves to `apps/vscode` later).

## Plan

`docs/outline/README.md` is the authoritative plan. `docs/STATUS.md`, `docs/plans/` and `docs/research/` are historical: do not treat them as current.

## Package manager

- Install, run scripts, and execute local binaries with bun (`bun install`, `bun run <script>`, `bun run <bin>`).
- The test suite is `bun run test`. `bun test` is Bun's own runner and does not run this repo's vitest suite.
- The lockfile is `bun.lock`. Do not add `package-lock.json`, and do not invoke npm or npx.
- The human-facing command list is in `README.md`.

## Git hooks (lefthook)

- pre-commit: formats staged files with oxfmt and restages them, then runs oxlint and `check:deps`.
- pre-push: runs the full `bun run check`; it never skips.
- Emergency bypass only: `LEFTHOOK=0 git commit ...` (CI still runs every gate).

## Hard rules

- No `import 'vscode'` anywhere under `packages/**` (enforced by `tools/check-deps.mjs`).
- `@cpg/model` has ZERO runtime dependencies. Never add one (zod included).
- zod only at boundaries where outside data enters (config loader, MCP inputs). It arrives with its first consumer (U1 schema generator or U2 config loader).
- Unused variables/parameters are oxlint's job (tsc's noUnused* flags are off); prefix intentional ones with `_`.
- Every new gate needs a case in `tools/prove-gates.mjs` that plants a violation, with `expectOutput`. Slow cases get `slow: true` (skipped when `PROVE_GATES_SKIP_SLOW=1`, as in PR CI; the weekly mutation workflow runs them).
- Build state lives inside the output dirs (`dist/.tsbuildinfo`, `out/.tsbuildinfo`); when anything build-related looks stale, run `bun run clean`.
- One PR = one unit of work, 200-500 lines.
- Stubs are labelled REAL / PASSTHROUGH / SEAT: say which one when you add a stub, and never present a PASSTHROUGH or SEAT as working.
- Do not restructure packages (`packages/ast-generator` is a stub slated for removal in U0.1.2).

## Agent notes

- `CLAUDE.md` in a directory is a relative symlink to the sibling `AGENTS.md`. Edit `AGENTS.md`. Do not give `CLAUDE.md` its own text, and do not point at `AGENTS.md` with `@AGENTS.md`.
- A PostToolUse hook (`tools/claude-post-edit.mjs`) formats each edited file and surfaces oxlint errors; fix them before moving on.
- Run `bun run check` before declaring any work done.
