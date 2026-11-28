# cpg

Code Property Graph for TypeScript/JavaScript/Python: a bun-workspaces TypeScript monorepo.
`packages/model` (`@cpg/model`) is the real package; `apps/vscode/src/extension.ts` is the VS Code host.

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
- Emergency bypass only: `LEFTHOOK=0 git commit ...` (CI still runs `bun run check`).

## Hard rules

- No `import 'vscode'` anywhere under `packages/**` (enforced by `tools/check-deps.mjs`).
- `@cpg/model` has ZERO runtime dependencies. Never add one (zod included).
- zod only at boundaries where outside data enters (config loader, MCP inputs). It arrives with its first consumer (U1 schema generator or U2 config loader).
- Unused variables/parameters are oxlint's job (tsc's noUnused* flags are off); prefix intentional ones with `_`.
- Every new gate needs a case in `tools/prove-gates.mjs` that plants a violation, with `expectOutput`. Slow cases get `slow: true` (skipped when `PROVE_GATES_SKIP_SLOW=1`). A pull request's CI runs only `check`, so run `PROVE_GATES_SKIP_SLOW=1 bun run check:gates` yourself when you add or change a gate; CI's `gates` job runs it when dispatched with `full`, and the weekly Mutation workflow runs every case.
- Build state lives inside the output dirs (`dist/.tsbuildinfo`, `apps/vscode/dist/.tsbuildinfo`); when anything build-related looks stale, run `bun run clean`.
- One PR = one unit of work, about 200-500 lines of production code. Tests, fixtures and package scaffolding don't count toward that. Report both numbers in the PR body.
- Stubs are labelled REAL / PASSTHROUGH / SEAT: say which one when you add a stub, and never present a PASSTHROUGH or SEAT as working.
- Do not restructure packages.

## Agent notes

- `CLAUDE.md` in a directory is a relative symlink to the sibling `AGENTS.md`. Edit `AGENTS.md`. Do not give `CLAUDE.md` its own text, and do not point at `AGENTS.md` with `@AGENTS.md`.
- A PostToolUse hook (`tools/claude-post-edit.mjs`) formats each edited file and surfaces oxlint errors; fix them before moving on.
- Run `bun run check` before declaring any work done.

## Unit workflow (lessons from U1 and U2a.2)

What earned its keep, and should stay:

- Red commit first: SEAT stubs plus tests whose expected values come from the spec or the ladder, never from running code. The implementer passed first time in every unit (U1: 7/7, U2a.2: 3/3).
- One test review by a different model, asking only for named defects: "a test a plausible wrong implementation passes", "an in-scope behaviour with no test", "an expected value that contradicts the contract". A second round only fixes what was named. Every review found real defects. Ignore "redundant assertion" notes.
- Sabotage every new runtime file with 10-15 mutations. Each U2a.2 unit had a non-equivalent survivor, so it is a real test gap, not ceremony. Read the file before writing mutations so each one applies and is plausible. Report kills, equivalents and invalid mutants separately.
- Gate and ship are scripts, not prompts. The gate checks that tests are unchanged since RED, runs `bun run check`, and measures diff size.
- Size a story from the archive's line counts before writing stubs, and split it up front when its production code alone passes about 500 lines.

Fixes for things that cost time:

- CI lints before it builds, so type-aware oxlint there sees `@cpg/*` types as `any`. Run `bun run clean` before the final `bun run check`, or a lint result can pass locally and fail in CI.
- PRs that each add a package collide on the same registration lines (`tsconfig.json` references, `tsconfig.test.json` paths, `knip.json`). Stack them instead of branching both from `develop`.
- An implementation brief must not add semantics beyond the contract. One brief said removing `'.'` drops everything, contradicting C-STORE INV-7, and the implementer did exactly that. Check every rule in a brief against the cited invariants.
- To commit round-two tests on top of an implementation that is still uncommitted, stage only the test paths (`git add <tests> && git commit`). Don't stash. A stash takes the test edits along with the implementation.
- Re-read a file after oxfmt runs before string-matching it for an edit; the formatter reflows lines.
- Run a long CLI job (`agy -p ...`) as the background command itself. Wrapping it in `( ... ) &` detaches it, and then its completion is never reported.
- Type-check the lib, not just the runtime. oxlint requires `toSorted`, which needs `ES2023.Array` in the tsconfig `lib`, even though Node already has it.
- A new herdr pane may open on an oh-my-zsh update prompt that swallows the first keystroke. Check the pane before trusting it. `vitest watch` beside a running `bun run check` prints ENOSPC watcher errors for coverage temp files; they are noise.
