# packages/*

- Packages are scoped `@cpg/<name>` and `"private": true` — implementation detail of the extension, not published standalone.
- New packages are picked up by `package.json`'s `workspaces` glob automatically; still add the dependency entry so npm links it.
- Every package targets Node (`"types": ["node"]`) except `@cpg/graph-visualizer` (browser) — see its `AGENTS.md`.
- `npm run build` (`tsc -p .`) in each package compiles `src/` to `dist/`; consumers import `dist/`, so editing `src/` alone doesn't update what's resolved.
