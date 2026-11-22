# apps/cli: agent notes

Status (U2a.1): REAL: `run(argv, io, opts)`, `Io`/`captureIo`, `EXIT`/`exitCodeFor`, the `CommandSpec` table and `renderUsage`, `--version`/`--help`, flag validation before any `engine.connect`, and the built bin (spawned by `tools/check-cli-bin.mjs`). SEAT: every verb handler (`index`, `watch`, `query`, `verify`, `inspect`, `doctor`, `config`, `schema`) exits 2 "not built yet"; reserved `mcp`/`status` likewise. `src/engine.ts` is the CLI's slice of the `CpgEngine` port until `@cpg/engine` exists (U2a.2). See `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- Imports node builtins and `@cpg/*` front doors only. No host SDK.
