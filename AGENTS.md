# cpg-me-daddy

Monorepo VS Code extension that builds a Code Property Graph (CPG) for a workspace.

## Layout

- `src/` — extension host (`extension.ts`).
- `packages/*` — `@cpg/*` packages consumed by the extension host; see `packages/AGENTS.md`.
- `out/` — build output (gitignored, never hand-edited).
- `esbuild.js` — bundles `src/webview/graphApp.ts` into `out/webview/graph.js`.
- `tsconfig.json` — compiles `src/` into `out/`; references every `packages/*` project it depends on.
- `tsconfig.base.json` — shared compiler options for every `packages/*` project (`composite: true`).

## Build

Uses TypeScript project references (`tsc -b`); the extension host imports each package's compiled `dist/`.

```
npm run compile           # packages, then extension host (tsc -b), then webview
npm run compile:packages  # tsc -b across every packages/* project
npm run compile:ext       # tsc -b ./ (extension host)
npm run compile:web       # esbuild (webview bundle)
npm run watch             # watch mode for ext + webview
```

New cross-package import → add a matching `{ "path": "../<pkg>" }` to `references` in the importing package's `tsconfig.json` (and to the root `tsconfig.json` if the extension host gains a new dependency).
