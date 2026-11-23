# apps/inspector: agent notes

Status (U2b.1 part 2b): REAL: `layoutPayload` (seeded radial seed layout), the node and relationship type registries, the headless renderer (`GraphVisualizer` over a `GraphSurface`, a `Pick` of cosmos.gl's `Graph`), and the page: `graphShellHtml` (strict CSP, connect source per owner decision 10a, `#cpg-verification` reserved), the themed component CSS (decision 11a), the DOM views (`mountGraphViews`), the cosmos.gl config (`graphConfig`), the page logic (`startGraphApp` over a `PageChannel`) and the bundle (`bun run build:inspector`, `tools/build-inspector.mjs`). SEAT: the page channel in the bundle entry `graph-page.ts`, so the bundle does not run yet. Not built: the server, `WebviewTransport`, the WebSocket channel, render-report, the banner's report and `cpg inspect` (part 3).
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- May import DOM/WebGL. Imports `@cpg/*` front doors only, no deep imports.
- `@cosmos.gl/graph` (exact pin, owner decision 7a) is this app's one library. It is ESM-only and the app is CommonJS, so a type import needs `with { 'resolution-mode': 'import' }`. Only `src/graph-page.ts`, the bundle entry, imports it at runtime: `tsc -b` skips that file and `tsconfig.page.json` (DOM lib, bundler resolution, `@cpg/model` from source) typechecks it as part of `bun run typecheck`.
- The DOM views are typed against the structural `ViewElement<E>`/`ViewDocument<E>`, which the real DOM satisfies, so they compile without the DOM lib and the tests drive them with a fake document.
