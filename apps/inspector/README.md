# inspector

The browser picture of the graph: a static server plus a webview bundle that renders what the producer emits (`--inspect`).

`cpg-inspector` (`dist/main.js`) is the process: it reads NDJSON (`graph`, `graph-delta`, `verification`) on stdin, serves the picture on `http://127.0.0.1:<port>/`, writes `{"type":"listening","url":...}` and then each render-report on stdout, and exits when stdin ends. Build the page with `bun run build:inspector` first.
