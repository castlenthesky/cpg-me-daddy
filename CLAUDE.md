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
- **The integration harness owns its database.** It runs on 127.0.0.1:6381 — not 6379 (the conventional
  dev instance) and not 6380 (taken by the ast-demo benchmark). Before the first test it makes the server
  prove it is ours three ways: a provenance nonce stamped inside the container by `bun run db:up`, the
  exact `FALKORDB_ARGS` from `docker/falkordb.yml`, and the absence of any graph key not prefixed
  `cpg_test_`. Any of the three failing is a hard error. Never relax this into "something answered on the
  port" — `docker compose up` can fail with *port is already allocated* while `PING` on that port still
  answers, from the container that already owns it.
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
| `bun run typecheck` | `tsc --build` across the project references, then the no-emit test/tools pass |
| `bun run watch` | `tsc --build --watch` |
| `bun run test:unit` | `bun test` for all three packages. DB-free by design |
| `bun run db:up` | Start the pinned FalkorDB (docker/falkordb.yml, 127.0.0.1:6381) and verify provenance |
| `bun run db:down` | Stop it and discard its volume + provenance record |
| `bun run test:integration` | `bun test` against that live FalkorDB |
| `bun run test:integration:network` | Also runs F3's download + redis-server spawn suite. Opt-in, never in CI. |

Run the extension with the "Run Extension" launch configuration (F5); it points at `packages/vscode`.
Extension-host tests use `@vscode/test-cli` (`packages/vscode/.vscode-test.mjs`) and land in M3.

## The standing gates

Every PR keeps these green, not just its own new test:

```
bun run lint && bun run format:check && bun run typecheck && bun run test:unit
```

The integration suite is separate because it needs a database:

```
bun run db:up && bun run test:integration && bun run db:down
```

`lefthook.yml` runs lint + format check on `pre-commit` and typecheck + unit tests on `pre-push`, so the
gate fires before a commit exists. `.github/workflows/ci.yml` runs the same four commands on
ubuntu-latest and macos-latest (job `gates`, deliberately DB-free), plus a ubuntu-only `integration` job
that brings the pinned FalkorDB up with the same `docker/falkordb.yml` developers use.

## FalkorDB acquisition (F3)

FalkorDB publishes **no standalone server binary** — every release asset is a Redis module (`.so`).
`engine.db.mode: spawned` therefore runs `redis-server --loadmodule <cached .so>` and depends on a
`redis-server` the FalkorDB project does not ship. `packages/engine/src/server/` holds the
`ServerManager` interface and the Spawned / Remote / Docker implementations.

Two rules in that directory are load-bearing:

- **Nothing launches unverified.** The cached module's SHA-256 must match `manifest.ts`, which pins
  real hashes for the v4.20.4 assets. A mismatch quarantines the file and refuses to launch — it
  never silently re-downloads.
- **The cached module is always `chmod +x`.** A download lands at mode 0644 and redis-server aborts
  with `Module <path> failed to load: It does not have execute permissions.` This is regression-tested.

Environment overrides: `CPG_CACHE_DIR` (cache root, default `~/.cache/cpg`), `CPG_REDIS_SERVER`
(redis-server path), `CPG_FALKORDB_PLATFORM` (pin a specific release asset, e.g. `linux-x64-rhel9`).

`test/unit/**` never touches the network — it runs against a local fixture origin and a fake Redis.
The real download-and-spawn gate lives in `packages/engine/test/integration/`, is excluded from
`test:unit` by path, and additionally requires `CPG_INTEGRATION_FALKORDB=1`.

## TypeScript layout

`tsconfig.base.json` holds the shared compiler options (module/moduleResolution NodeNext, target ES2022,
`strict`, `composite`, `declaration`). The root `tsconfig.json` is a solution file — `"files": []` plus
references to the three packages — so `tsc --build` from the root builds everything in dependency order.
Each package compiles `src/` to `dist/`.

`tsconfig.test.json` is a second, no-emit pass over `packages/*/test/**` and `tools/**`. Those files
import engine sources by explicit `.ts` path so `bun test` runs them without a prior build, which needs
`allowImportingTsExtensions`, which needs `noEmit`, which cannot coexist with the composite projects in
the solution file. `bun run typecheck` runs both passes.

`@cpg/engine` publishes a `"bun"` export condition pointing at `src/index.ts`, so `bun test` resolves the
engine's source directly and unit tests do not require a prior `tsc --build`. Node and `tsc` resolve the
built `dist/` output as usual.
