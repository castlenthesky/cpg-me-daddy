# apps/inspector: agent notes

Status (U2b.1 part 1): REAL: `layoutPayload` (seeded radial seed layout), the node and relationship type registries. Not built: the renderer, legend and shell (part 2), the server, `WebviewTransport` and `cpg inspect` (part 3).
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- May import DOM/WebGL. Imports `@cpg/*` front doors only, no deep imports.
