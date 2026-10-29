# cpg-me-daddy

`cpg` is a command-line tool that maintains a live, sparse, structural code graph of a codebase:
*a fresh, sparse, structural cross-file call-and-import graph, visible and queryable within 2 seconds
of a save.* It is aligned to Joern's vocabulary so the flow tiers can be added later without renaming
anything, but it is not a code property graph in Joern's sense today. Until the headless Python
resolver lands (U8), it also cannot claim full call recall.

**Start here:** [`docs/outline/README.md`](docs/outline/README.md) is the whole plan — what is being
built, why, and how "done" is decided. Work is picked from
[`docs/outline/07-milestones.yaml`](docs/outline/07-milestones.yaml).

## Layout

- `packages/*` — core: host-free, runs under plain node, no composition roots.
- `apps/*` — front doors: each owns one composition root and may import only its own host SDK.
  `apps/vscode` is the VS Code extension (the manifest stays in the root `package.json`).

`tools/check-deps.mjs` enforces the split; CI proves it fails on planted violations.

## Running

```
npm ci
npm run verify   # dependency gate, tsc -b, vitest
```

Then press F5 in VS Code to launch the Extension Development Host and run **CPG: Hello World**.
