# inspector

The browser picture of the graph: a static server plus a webview bundle that renders what the producer emits (`--inspect`).

`cpg-inspector` (`dist/main.js`) is the process: it reads NDJSON (`graph`, `graph-delta`, `verification`; a `graph` may say `"cause": "initial"` to start a new epoch, else after the first it is a catch-up) on stdin, serves the picture on `http://127.0.0.1:<port>/`, writes `{"type":"listening","url":...}` and then each render-report on stdout, and exits when stdin ends. Build the page with `bun run build:inspector` (or `bun run compile`) first.

`@cpg/inspector`'s front door (`src/index.ts`) is what the VS Code host imports: the page shell, the parser for the page's messages, the banner's text and the registry's node colours. It loads none of the server, `ws`, cosmos.gl or the renderer.
