# cpg

Code Property Graph for TypeScript/JavaScript/Python: an npm-workspaces TypeScript monorepo.
`packages/model` (`@cpg/model`) is the real package; `src/extension.ts` is the VS Code host (moves to `apps/vscode` later).

## Plan

`docs/outline/README.md` is the authoritative plan. `docs/STATUS.md`, `docs/plans/` and `docs/research/` are historical: do not treat them as current.

## Commands (npm only)

| Command                 | What it does                                    |
| ----------------------- | ----------------------------------------------- |
| `npm run check`         | THE gate: every fast check via turbo (cached)   |
| `npm run check:gates`   | Proves each gate fails on a planted violation   |
| `npm run format`        | oxfmt write                                     |
| `npm run lint:fix`      | oxlint autofix                                  |
| `npm test`              | vitest (unit, property, type tests)             |
| `npm run test:coverage` | vitest with coverage thresholds                 |
| `npm run test:mutation` | Stryker mutation testing (slow, not in `check`) |
| `npm run typecheck`     | `tsc -b`                                        |
| `npm run knip`          | unused files/exports/deps                       |
| `npm run changeset`     | record a semver change for a package            |

## Hard rules

- No `import 'vscode'` anywhere under `packages/**` (enforced by `tools/check-deps.mjs`).
- `@cpg/model` has ZERO runtime dependencies. Never add one.
- Every new gate needs a case in `tools/prove-gates.mjs` that plants a violation and asserts failure.
- One PR = one unit of work, 200-500 lines.
- Stubs are labelled REAL / PASSTHROUGH / SEAT: say which one when you add a stub, and never present a PASSTHROUGH or SEAT as working.
- Do not restructure packages (`packages/ast-generator` is a stub slated for removal in U0.1.2).

## Agent notes

- A PostToolUse hook (`tools/claude-post-edit.mjs`) formats each edited file and surfaces oxlint errors; fix them before moving on.
- Run `npm run check` before declaring any work done.
