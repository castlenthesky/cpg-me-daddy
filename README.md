# cpg-me-daddy

Code Property Graph for TypeScript/JavaScript/Python. The plan is
[`docs/outline/README.md`](docs/outline/README.md).

## Running

```
bun install
bun run compile
```

Then press F5 in VS Code to launch the Extension Development Host.

## Commands

| Command                     | What it does                                                                |
| --------------------------- | --------------------------------------------------------------------------- |
| `bun run check`             | THE gate: every fast check via turbo (cached). `verify` is an alias         |
| `bun run check:gates`       | Proves each gate fails on a planted violation (`-- --only-slow`: slow only) |
| `bun run format`            | oxfmt write                                                                 |
| `bun run format:check`      | oxfmt check                                                                 |
| `bun run lint`              | oxlint, type-aware, warnings denied (owns unused vars/params)               |
| `bun run lint:fix`          | oxlint autofix                                                              |
| `bun run typecheck`         | `tsc -b`                                                                    |
| `bun run typecheck:tests`   | `tsc` over all test files (incl. type tests)                                |
| `bun run check:deps`        | dependency-direction rules (`tools/check-deps.mjs`)                         |
| `bun run check:pack`        | asserts what `bun pm pack` would ship                                       |
| `bun run knip`              | unused files/exports/deps                                                   |
| `bun run test`              | vitest (unit, property, type tests)                                         |
| `bun run test:coverage`     | vitest with coverage thresholds                                             |
| `bun run test:mutation`     | Stryker mutation testing (slow, not in `check`)                             |
| `bun run clean`             | SAFE FULL RESET: out, dist, tsbuildinfo, turbo, coverage, reports, stryker  |
| `bun run compile` / `watch` | `tsc -b` / `tsc -b -w`                                                      |
| `bun run changeset`         | record a semver change for a package                                        |
| `bun run version-packages`  | apply changesets (`changeset version`)                                      |
