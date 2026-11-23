# apps/inspector: agent notes

Status (U2b.1 part 2a): REAL: `layoutPayload` (seeded radial seed layout), the node and relationship type registries, and the headless renderer: `GraphVisualizer` (`visualizer.ts`) over a `GraphSurface` (a `Pick` of cosmos.gl's `Graph`) composing the buffer store, edge store, legend rows, tooltip text and camera controller. Not built: the DOM views, cosmos `Graph` construction, styles, shell and bundle (part 2b), the server, `WebviewTransport`, render-report and `cpg inspect` (part 3).
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- May import DOM/WebGL. Imports `@cpg/*` front doors only, no deep imports.
- `@cosmos.gl/graph` (exact pin, owner decision 7a) is this app's one library. It is ESM-only and the app is CommonJS, so a type import needs `with { 'resolution-mode': 'import' }`.
