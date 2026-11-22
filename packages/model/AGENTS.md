# packages/model: agent notes

Status: Built in U0, U1; see `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- Zero runtime dependencies, ever. No host SDK, no `node:fs`.
- Paths (DQ-02): the graph stores only `WorkspacePath` (workspace-relative, POSIX `/`, `'.'` is the root). Convert disk paths with `toWorkspacePath` (startsWith + slice, L-10), never by string replace.
- `toAbsolutePath` is for FilesystemProbe and SourceOpener implementations only; check-deps will verify its import sites in a later unit.
