# cpg-me-daddy

Code Property Graph for TypeScript/JavaScript/Python. The plan is
[`docs/outline/README.md`](docs/outline/README.md).

## Layout

- `packages/*` — core: host-free, runs under plain node, no composition roots.
- `apps/*` — front doors: each owns one composition root and may import only its own host SDK.
  `apps/vscode` is the VS Code extension (the manifest stays in the root `package.json`).

`tools/check-deps.mjs` enforces the split; CI proves it fails on planted violations.

## Running

```
bun install
bun run compile
```

Then press F5 in VS Code to launch the Extension Development Host and run **CPG: Hello World**.

## Commands

| Command                     | What it does                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bun run check`             | THE gate: every fast check via turbo (cached). `verify` is an alias                                              |
| `bun run check:gates`       | Proves each gate fails on a planted violation (`-- --only-slow`: slow only)                                      |
| `bun run format`            | oxfmt write                                                                                                      |
| `bun run format:check`      | oxfmt check                                                                                                      |
| `bun run lint`              | oxlint, type-aware, warnings denied (owns unused vars/params)                                                    |
| `bun run lint:fix`          | oxlint autofix                                                                                                   |
| `bun run typecheck`         | `tsc -b`                                                                                                         |
| `bun run typecheck:tests`   | `tsc` over all test files (incl. type tests)                                                                     |
| `bun run check:deps`        | dependency-direction rules (`tools/check-deps.mjs`)                                                              |
| `bun run check:pack`        | asserts what `bun pm pack` would ship                                                                            |
| `bun run check:cli-bin`     | builds `apps/cli` and runs the built `cpg` bin (`tools/check-cli-bin.mjs`)                                       |
| `bun run check:purity`      | runs the bin's `cpg index --dry-run` under a `Module._load` trap, then `--plant` (`tools/purity-proof.mjs`)      |
| `bun run schema:doc`        | regenerates the GENERATED region of `docs/outline/04-schema.yaml` from `CPG_SCHEMA` (`--check` exits 1 on drift) |
| `bun run knip`              | unused files/exports/deps                                                                                        |
| `bun run test`              | vitest (unit, property, type tests)                                                                              |
| `bun run test:coverage`     | vitest with coverage thresholds                                                                                  |
| `bun run test:mutation`     | Stryker mutation testing (slow, not in `check`)                                                                  |
| `bun run clean`             | SAFE FULL RESET: out, dist, tsbuildinfo, turbo, coverage, reports, stryker                                       |
| `bun run compile` / `watch` | `tsc -b` / `tsc -b -w`                                                                                           |
| `bun run changeset`         | record a semver change for a package                                                                             |
| `bun run version-packages`  | apply changesets (`changeset version`)                                                                           |
