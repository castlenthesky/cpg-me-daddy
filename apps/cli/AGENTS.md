# apps/cli: agent notes

Status (U2a.1): REAL: `run(argv, io, opts)`, `Io`/`captureIo`, `EXIT`/`exitCodeFor`, the `CommandSpec` table and `renderUsage`, `--version`/`--help`, flag validation before any `engine.connect`, and the built bin (spawned by `tools/check-cli-bin.mjs`). REAL (U2a.2d): `cpg index --dry-run`, and `main.ts` as the composition root (`createEngine` with the MemoryStore sink). SEAT: `index` without `--dry-run` (its door is `--store memory`, U2c.2) and every other verb handler (`watch`, `query`, `verify`, `inspect`, `doctor`, `config`, `schema`), each of which exits 2 "not built yet"; the reserved `mcp`/`status` do the same. The `CpgEngine` port lives in `@cpg/engine`. See `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- Imports node builtins and `@cpg/*` front doors only. No host SDK.
- `src/contracts-agree.test-d.ts` is the cross-package contract-agreement test (model/resolve/watch today). Add each pair in the PR that creates its second side.
