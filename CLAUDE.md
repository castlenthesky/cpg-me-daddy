# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`cpg-me-daddy` builds a Code Property Graph over TypeScript/JavaScript/Python and exposes it to editors
and agents. It is a **bun workspace monorepo**:

- `packages/engine` (`@cpg/engine`) — the pure TypeScript core. Parsing, graph construction, storage.
- `packages/cli` (`@cpg/cli`) — the `cpg` command line interface.
- `packages/vscode` (`@cpg/vscode`) — the VS Code extension (manifest, activation, UI).

The delivery plan lives in `.agent/knowledge/planning-sessions/2026-09-11.project-outline/60-delivery.yaml`.

## Hard rules

- **Engine purity.** Nothing under `packages/engine` may import `vscode` (or `@cpg/vscode`). This is
  enforced by `no-restricted-imports` in `.oxlintrc.json` and it is a build-breaking gate, not a
  convention. Editor APIs live in `packages/vscode`; plain data crosses into the engine.
- **Dependency direction.** `cli` and `vscode` may depend on `engine`. `engine` depends on neither.
- **Package manager is `bun`.** `bun.lock` is the lockfile; there is no `package-lock.json`.
- **Legacy trees are reference only.** The top-level `src/`, `test/`, `scripts/`, `out/`, `media/`,
  `resources/`, `build/` are the pre-monorepo prototype. They are excluded from the workspace build,
  from oxlint and from oxfmt. Do not extend them; later M0 units consume `src/types/cpg.ts` and then
  delete the tree.

## Development Commands

| Command | What it does |
| --- | --- |
| `bun install` | Install workspace dependencies and (via `prepare`) install the git hooks |
| `bun run lint` | oxlint over `packages/**` |
| `bun run format` | oxfmt, writing in place |
| `bun run format:check` | oxfmt in check mode (the CI gate) |
| `bun run typecheck` | `tsc --build` across the project references |
| `bun run watch` | `tsc --build --watch` |
| `bun run test:unit` | `bun test` for all three packages |

Run the extension with the "Run Extension" launch configuration (F5); it points at `packages/vscode`.
Extension-host tests use `@vscode/test-cli` (`packages/vscode/.vscode-test.mjs`) and land in M3.

## The standing gates

Every PR keeps these green, not just its own new test:

```
bun run lint && bun run format:check && bun run typecheck && bun run test:unit
```

`lefthook.yml` runs lint + format check on `pre-commit` and typecheck + unit tests on `pre-push`, so the
gate fires before a commit exists. `.github/workflows/ci.yml` runs the same four commands on
ubuntu-latest and macos-latest.

## TypeScript layout

`tsconfig.base.json` holds the shared compiler options (module/moduleResolution NodeNext, target ES2022,
`strict`, `composite`, `declaration`). The root `tsconfig.json` is a solution file — `"files": []` plus
references to the three packages — so `tsc --build` from the root builds everything in dependency order.
Each package compiles `src/` to `dist/`.

`@cpg/engine` publishes a `"bun"` export condition pointing at `src/index.ts`, so `bun test` resolves the
engine's source directly and unit tests do not require a prior `tsc --build`. Node and `tsc` resolve the
built `dist/` output as usual.
