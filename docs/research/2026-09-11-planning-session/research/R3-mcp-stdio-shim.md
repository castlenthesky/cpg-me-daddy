# R3 — MCP protocol, host behaviour, and the `cpg mcp` stdio shim

Research date: 2026-09-11. Legend: **[V]** verified against a primary source listed under Sources; **[I]** inference or secondary/community evidence.

## Executive summary

- **The protocol moved under us.** MCP revision **2026-07-28** (stable, released ~6 weeks ago) removed the `initialize` handshake and protocol-level sessions: every request carries `_meta.io.modelcontextprotocol/protocolVersion` + `clientCapabilities`, servers MUST implement `server/discover`, results carry `resultType`, `ping`/`logging/setLevel` are gone, and Roots/Sampling/Logging are **deprecated** (log to stderr instead). HTTP+SSE is formally Deprecated. **[V]** No evidence that Claude Code, Cursor, VS Code, Codex, Windsurf or JetBrains have shipped "modern" clients yet **[I]** → the shim must be **dual-era** (answer legacy `initialize` *and* modern `_meta` requests).
- **SDK target:** TypeScript SDK **v2.0.0** (published 2026-07-27; packages `@modelcontextprotocol/server`, `/client`, `/core`, `/node`, `/server-legacy`; Node ≥20, zod ^4.2). `serveStdio(factory)` from `@modelcontextprotocol/server/stdio` negotiates the era per connection, so one codebase serves both. v1 `@modelcontextprotocol/sdk@1.30.0` is maintenance-only. **[V]**
- **stdio hygiene is simple and absolute:** stdout = newline-delimited JSON-RPC only, no embedded newlines; stderr MAY carry any UTF-8 logging and clients SHOULD NOT treat it as an error; exit promptly on stdin EOF. **[V]** The spec also says custom transports over Unix sockets/TCP **SHOULD reuse the stdio framing** — which means the shim can forward NDJSON to the engine nearly verbatim. **[V]**
- **Host reality:** spawn cwd is the workspace root only in VS Code (documented `cwd` default) and Claude Code (project/local scope) **[V]**; Cursor/Cline-family hosts have been observed spawning with `cwd=/` **[I]**. Therefore **never rely on `process.cwd()`** — resolve the workspace from an explicit `--workspace <path>` arg populated by `${workspaceFolder}` / `${CLAUDE_PROJECT_DIR}` / Codex `cwd`, with `process.cwd()` as last fallback.
- **Tool budget:** Cursor ≈40 active tools (community-reported, warning "Exceeding total tools limit") **[I]**, Windsurf 100 **[V]**, VS Code 128 hard cap per request **[V]**, Claude Code auto-defers tool schemas via Tool Search once descriptions exceed ~10% of context **[V]**, OpenAI advises <20 functions active per turn **[V]**. Ship **≤12 tools**, `snake_case` verb_noun, short server name (`cpg`) because Claude Code renders `mcp__cpg__find_symbol`.
- **Read-only Cypher:** `GRAPH.RO_QUERY` rejects any write clause with an error ("graph.RO_QUERY is to be executed only on read-only queries") **[V/I]**; layer it with a static keyword pre-check, the per-query `TIMEOUT` argument, `TIMEOUT_MAX`/`RESULTSET_SIZE`/`QUERY_MEM_CAPACITY` server config, and a shim-side byte/token cap. Beware `falkordb/falkordb:latest` ships `TIMEOUT=1000ms`. **[V]**

## Host behaviour matrix (stdio servers)

| Host | Config file(s) & shape | Spawn cwd | Env passing | Instances | Startup / tool timeout | Tool surfacing & limits |
|---|---|---|---|---|---|---|
| **Claude Code** | Project: `.mcp.json` `{mcpServers:{name:{type:"stdio",command,args,env,timeout}}}`; local/user: `~/.claude.json`. `claude mcp add --scope project cpg -- cpg mcp` **[V]** | Project dir for project/local scope; config dir for user scope **[V]** | `env` map; `${VAR}`/`${VAR:-default}` expansion; always sets `CLAUDE_PROJECT_DIR` **[V]** | One per configured server per session **[V]** | `MCP_TIMEOUT` (ms) startup; per-server `timeout` ms; stdio idle 30 min **[V]** | Names `mcp__<server>__<tool>`; property names ≤64 chars; output cap `MAX_MCP_OUTPUT_TOKENS` 25k (warn 10k), raise via `_meta["anthropic/maxResultSizeChars"]`; Tool Search defers schemas >10% context; project `.mcp.json` needs one-time approval **[V]** |
| **Cursor** | `.cursor/mcp.json` (project) / `~/.cursor/mcp.json`; `{mcpServers:{name:{type:"stdio",command,args,env,envFile}}}` **[V]** | Undocumented; forum reports `process.cwd()` ≠ workspace **[I]** | `env`, `envFile`; interpolation `${workspaceFolder}`, `${env:NAME}`, `${userHome}` **[V]** | Per window **[I]** | Undocumented | ≈40 active tools across all servers, silent loss beyond (some reports of 80) **[I]**; per-tool toggles in UI **[V]** |
| **VS Code / Copilot** | `.vscode/mcp.json` `{servers:{name:{type:"stdio",command,args,env,envFile,cwd}},inputs:[…]}`; user-level config; extension API `contributes.mcpServerDefinitionProviders` + `vscode.lm.registerMcpServerDefinitionProvider` → `McpStdioServerDefinition{label,command,args,cwd:Uri,env,version}` **[V]** | `cwd` field, **defaults to workspace folder** **[V]** | `env`, `envFile`, `${workspaceFolder}` **[V]** | Per window (server started on demand) **[I]** | Undocumented; `dev.watch` restarts **[V]** | **128 tools/request hard cap**; virtual-tool grouping above `github.copilot.chat.virtualTools.threshold` (≤128) **[V]** |
| **Codex CLI** | `~/.codex/config.toml`; project `.codex/config.toml` only when project trusted. `[mcp_servers.cpg] command args env env_vars cwd startup_timeout_sec tool_timeout_sec enabled enabled_tools disabled_tools` **[V]** | `cwd` field; default unspecified (assume Codex's cwd) **[I]** | `env` map + `env_vars` allow-list **[V]** | Per session **[I]** | `startup_timeout_sec` default **10 s**; `tool_timeout_sec` default **60 s** **[V]** | Allow/deny lists per server; no documented count cap **[V]** |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` only (no project file documented); `{mcpServers:{name:{command,args,env}}}` **[V]** | Undocumented **[I]** | `env` **[V]** | Per window **[I]** | Undocumented | **100 total tools** cap; per-tool toggles **[V]** |
| **JetBrains AI Assistant** | Settings › Tools › AI Assistant › MCP; JSON import in Claude-Desktop shape `{mcpServers:{name:{command,args,env}}}`; optional *working directory* field; Global vs Project level **[V]** | Configurable per server; default unspecified **[I]** | `env` **[V]** | Per project **[I]** | Undocumented | Tools also exposed as `/` commands **[V]** |

## 1. Protocol and SDK facts

**Spec revision.** Current: **2026-07-28** (previous 2025-11-25). Headline changes **[V]**: (a) no `initialize`/`initialized`; version, client capabilities, optional `clientInfo` ride in `_meta` on every request; mismatches return `UnsupportedProtocolVersionError` (-32022) listing supported versions; (b) `server/discover` is mandatory — clients MAY call it first, and on stdio SHOULD use it as a legacy/modern probe; (c) `subscriptions/listen` replaces GET-stream/`resources/subscribe` for `toolsListChanged`, `resourcesListChanged`, etc.; `notifications/tools/list_changed` still exists but only flows to clients that opted in; (d) `ping`, `logging/setLevel`, roots list_changed removed; log level is per-request `_meta` `logLevel`, and servers MUST NOT emit `notifications/message` unless the request carried it; (e) Roots, Sampling, Logging **deprecated** (12-month window) — irrelevant to a read-only server anyway; (f) elicitation/sampling push requests replaced by **MRTR** (`resultType:"input_required"`); (g) all results carry `resultType`; (h) `tools/list`, `resources/list`, `resources/read` results MUST carry `ttlMs` + `cacheScope`, and tools SHOULD be returned in deterministic order (prompt-cache friendliness); (i) HTTP+SSE reclassified Deprecated → never implement; Streamable HTTP is the only HTTP binding.

**Tools.** Fields: `name`, `title`, `description`, `icons`, `inputSchema` (JSON Schema 2020-12; no-arg tools use `{type:"object",additionalProperties:false}`), `outputSchema`, `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) — clients MUST treat annotations as untrusted. Names SHOULD be 1–128 chars from `[A-Za-z0-9_.-]`, unique per server. If `outputSchema` is set, `structuredContent` MUST conform and SHOULD also be serialized into a `text` block. Execution errors → `isError:true` with actionable text (clients SHOULD feed these to the model); protocol errors → JSON-RPC errors (unknown tool = -32602). Pagination via opaque `cursor`/`nextCursor`. **[V]**

**stdio binding.** Server reads stdin, writes stdout; one JSON-RPC message per line, **MUST NOT** contain embedded newlines; server **MUST NOT** write non-MCP bytes to stdout; server **MAY** write UTF-8 logs to stderr and the client SHOULD NOT read stderr as failure; server SHOULD exit on stdin EOF; client SHOULD restart a crashed server (protocol is stateless, so in-flight calls are simply retried); server MUST NOT write JSON-RPC *requests* to stdout in the modern era. Custom transports over UDS/TCP SHOULD reuse this framing. **[V]**

**Dual-era.** A dual-era server serves `initialize` openers with legacy semantics scoped to the process, and `_meta` openers statelessly; modern-only servers SHOULD name supported versions in the error returned to `initialize`. **[V]** Given hosts were legacy on 2026-07-27 and the spec is 6 weeks old, assume **legacy clients for at least the next 12 months**. **[I]**

**SDK.** `@modelcontextprotocol/sdk` **1.30.0** (2026-07-27, Node ≥18, zod 3.25||4) — maintenance. **v2.0.0** monorepo (2026-07-27T23:55Z): `@modelcontextprotocol/{core,server,client,node,server-legacy,express,fastify,hono,codemod}`; `server` requires Node ≥20 and zod ^4.2, exports `./stdio`. `serveStdio(factory)` pins era at connection open; handlers written once in the `inputRequired(...)` style serve both eras; `registerTool` supports `outputSchema`, `annotations`, and the returned handle auto-emits `list_changed` on enable/disable/update; `registerResource(name, uri, meta, cb)` for a static schema resource; logging rule: `console.error` only. Migration docs: `docs/migration/upgrade-to-v2.md`, `docs/migration/support-2026-07-28.md`. **[V]**

## 2. Host behaviour details (beyond the table)

- **Claude Code** is the best-documented: relative `command`/`args` resolve against the project directory for project/local scope; `CLAUDE_PROJECT_DIR` is guaranteed and stable across mid-session `cd`; stdio servers are **not** auto-restarted after a crash (user must `/mcp` reconnect) — so the shim must never crash on engine hiccups, only report them. Text results above `MAX_MCP_OUTPUT_TOKENS` are spilled to a file. **[V]**
- **VS Code** is the only host with a documented `cwd` default equal to the workspace folder and a first-class extension API; our extension host should call `vscode.lm.registerMcpServerDefinitionProvider('cpg', …)` returning `new McpStdioServerDefinition({label:'cpg', command:<bundled cpg>, args:['mcp','--workspace',folder.fsPath], cwd:folder, version})`, fire `onDidChangeMcpServerDefinitions` when folders change, and gate `resolveMcpServerDefinition` on engine readiness. **[V]** VS Code also offers `chat.mcp.discovery.enabled` (reads Claude/Cursor configs) and a `sandbox` block for stdio servers — our shim must work with only read access to the workspace plus `.cpg/`. **[V]**
- **Codex** has the shortest startup budget (10 s) and tool budget (60 s) by default → the shim must answer `initialize`/`server/discover`/`tools/list` **without waiting for the engine**. **[V]**
- **Cursor/Windsurf/JetBrains** accept the Claude-Desktop JSON shape; only Cursor documents `${workspaceFolder}`. **[V]**

## 3. Tool count, descriptions, payloads, and prior art

**Limits and guidance.** Anthropic's tool-writing guide: build "a few thoughtful tools", namespace with a common prefix (prefix vs suffix placement measurably changes eval results — test it), describe tools "as you would to a new hire", offer a `response_format` enum (concise/detailed), paginate/truncate with instructions that steer the agent to narrower queries, prefer natural-language identifiers but expose IDs when needed downstream, and return specific actionable errors. **[V]** Anthropic's Tool Search docs and press coverage put selection degradation at roughly 30–50 tools **[I]**; OpenAI: "fewer than 20 functions available at the start of a turn." **[V]** Hard host caps: Cursor ≈40 **[I]**, Windsurf 100, VS Code 128. **[V]**

**Naming.** Spec allows `[A-Za-z0-9_.-]`; SEP-986 and the ecosystem converged on `snake_case` verb_noun (`find_symbol`, `callers_of` is noun-ish but fine as long as consistent). Claude Code prefixes `mcp__<server>__`, and validates property names to ≤64 chars — keep the server key short (`cpg`) and parameter names short. **[V]**

**JSON vs Markdown.** The only controlled study found (arXiv 2602.05447) reports no statistically significant aggregate accuracy difference between JSON/YAML/Markdown/TOON; frontier models vary 1.6–5.4% by format, open models up to 20%. Practitioners (chunkhound #173) cut ~65% tokens switching search results JSON→lean Markdown. **[I]** Spec guidance: `content` is model-oriented and token-efficient; `structuredContent` is machine-oriented. **[V]** ⇒ Return a compact tabular/Markdown text block *and* `structuredContent` conforming to `outputSchema`; budget both.

**Prior art worth copying.**
- **Neo4j `mcp-neo4j-cypher`**: three tools (`get_neo4j_schema`, `read_neo4j_cypher`, `write_neo4j_cypher`); `NEO4J_READ_ONLY=true` *removes* the write tool from the list; `NEO4J_RESPONSE_TOKEN_LIMIT` truncates with tiktoken; `NEO4J_READ_TIMEOUT` default 30 s; recursive sanitiser drops lists >128 items; optional namespace prefix when several instances run. Lesson: control **output volume and execution time**, not query shape — LLMs have no concept of computational cost. **[V]**
- **FalkorDB official MCP server**: `query_graph(readOnly)`, `query_graph_readonly`, `list_graphs`, `get_graph_schema`, `get_node_schema`, `get_relationship_schema`, plus **`delete_graph`** and create tools. Copy the schema-sampling trio; **avoid** shipping any destructive tool in a read-only v1 (a `destructiveHint` cannot be trusted by hosts anyway). **[V]**
- **Memgraph**: minimal `run_query` + `get_schema`. **[V]** **Context7**: two tools (resolve → query). **[V]** **Sourcegraph**: curated default set of ~6 tools at `/.api/mcp`, full suite at `/.api/mcp/all` — explicit "reduce tool-list noise" rationale. **[V]** **GitHub**: 162+ tools → toolsets + dynamic toolsets; 3–10 tools cut context 60–90%. **[V]** **Serena**: symbol-level `find_symbol(name_path, depth, include_body)`, `find_referencing_symbols`, `get_symbols_overview` — the closest naming analog for code-graph tools. **[V]**

## 4. Shim ↔ engine design prior art

- **Spec-level gift**: custom transports over UDS/TCP SHOULD reuse stdio NDJSON framing → the shim can be a **framing-preserving relay** that intercepts a handful of methods (`initialize`, `server/discover`, `tools/list`, `graph_status`, `wait_for_ready`) and forwards the rest line-for-line. **[V]**
- **Nx daemon**: Unix socket / Windows named pipe (`\\.\pipe\nx\…`); socket path asserted ≤95 chars with `NX_SOCKET_DIR` escape hatch; client *probes by connecting*, on `ENOENT` spawns the daemon detached with stdio redirected to a log file and `unref()`s it, then polls 10 ms × 6000 (60 s); a `VersionMismatchError` during the probe is treated as "unavailable → start fresh"; on mid-request disconnect it re-polls and re-sends. **[V]**
- **Gradle daemon**: registry file of running daemons; incompatible daemons (JVM/version criteria) are skipped and a new one is spawned. **[I]**
- **PID-file pitfalls**: Claude Code issue #72898 — after unclean shutdown a stale lock with a reused PID deadlocked every new daemon; fix = record and compare **process start time** (and image path) with the PID. `flock`-style kernel locks avoid the problem entirely because they die with the process. **[V]**
- **Docker MCP Gateway** (one stdio endpoint, on-demand backend start, tool routing, call tracing) and **mcp-proxy** (stdio↔Streamable HTTP bridge) prove the "thin front, long-lived back" pattern is mainstream. **[V]**
- **macOS** `sun_path` is 104 bytes (Linux 108); `$TMPDIR` on macOS is long enough to break this (documented failures in Claude Code #17658, VS Code Remote, Meteor). Windows uses `\\.\pipe\<name>` via Node `net`. **[V]** Localhost TCP avoids path limits and works on Windows today, at the cost of needing an auth token in the lock file. **[I]**

## 5. Read-only guarantees for a raw Cypher tool

- `GRAPH.RO_QUERY` executes only read operations and returns an error for `CREATE`, `SET`, `DELETE`, `MERGE` (creation) — reported error text: "graph.RO_QUERY is to be executed only on read-only queries"; it can also be routed to read replicas. **[V]** Whether side-effecting procedures (`CALL db.idx.*`) are blocked is undocumented — **spike**. **[I]**
- Query-level timeout: an optional `TIMEOUT <ms>` argument after the query string on `GRAPH.QUERY`/`GRAPH.RO_QUERY`/`GRAPH.PROFILE`; cannot exceed `TIMEOUT_MAX`. Since v2.10 `TIMEOUT_DEFAULT` and `TIMEOUT_MAX` replace legacy `TIMEOUT`; defaults are 0 (off) in docs, **but the `falkordb/falkordb:latest` image ships `TIMEOUT=1000`** (issue #1826). `RESULTSET_SIZE` (records), `QUERY_MEM_CAPACITY` (bytes/query), `MAX_QUEUED_QUERIES` are runtime-settable via `GRAPH.CONFIG SET` but **not persisted** across restart. **[V]**
- Recommended static pre-checks (defense in depth, not the guarantee): strip comments/strings, reject `\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV|FOREACH)\b` and `CALL\s+(db\.idx|dbms|graph\.)` write procedures; require the text to start with `MATCH|OPTIONAL MATCH|CALL|RETURN|WITH|UNWIND|CYPHER`; inject `LIMIT n` when absent. Additionally connect through a Redis ACL user limited to `+graph.ro_query +graph.list +graph.explain +graph.config|get` **[I — verify FalkorDB ACL support]**.

## 6. Recommendation for cpg-me-daddy

**SDK.** `@modelcontextprotocol/server@^2.0.0` (+ `@modelcontextprotocol/core`, zod 4) in the shim; `serveStdio(factory)` for dual-era. Engine speaks the same NDJSON framing over IPC so the shim can relay. Pin Node ≥20.

**stdio hygiene rules.**
1. Only the transport writes to `process.stdout`; in the shim's first lines, monkey-patch `console.log/info/debug` → stderr and set `process.stdout` to error on any non-transport write in dev builds.
2. One JSON object per line, `JSON.stringify` (never pretty-print), UTF-8, no ANSI.
3. Logs → stderr, prefixed `[cpg-mcp]`, rate-limited; also mirrored to `.cpg/logs/mcp-<pid>.log`.
4. Exit 0 within 500 ms of stdin EOF; handle `SIGTERM`; never `process.exit` on engine errors — return `isError` results instead (Claude Code will not restart a dead stdio server).
5. Deterministic `tools/list` order; set `ttlMs` (e.g. 300000) and `cacheScope:"private"`.
6. Never emit `notifications/message` unless the request carried `_meta` `logLevel`; never emit server→client requests.

**Tool conventions.** Server key `cpg`; ≤12 `snake_case` tools: `find_symbol`, `symbol_details`, `callers_of`, `callees_of`, `impact_of_change`, `path_between`, `file_outline`, `graph_status`, `wait_for_ready`, `cypher_readonly`, `schema`. Every tool: `annotations:{readOnlyHint:true, idempotentHint:true, openWorldHint:false}`, `outputSchema`, `structuredContent` + compact Markdown text; params `limit` (default 20, max 200), `response_format: "concise"|"detailed"`, `cursor`; each node carries `{id, kind, name, file, range, status: "fresh"|"stale"|"indexing"|"unknown"}`; truncation appends "N more — narrow with file= or raise limit". Resource `cpg://schema` (labels, edge types, property keys, counts, `ttlMs`). Result cap: 8 k tokens estimated (chars/4) by default, honoured before the host's 25 k cap; set `_meta["anthropic/maxResultSizeChars"]` only on `cypher_readonly`.

**Discovery / attach / start algorithm (shim).**
1. Resolve `workspaceRoot` = `--workspace` arg ‖ `CPG_WORKSPACE` ‖ `CLAUDE_PROJECT_DIR` ‖ `process.cwd()`; normalise to realpath; compute `wsHash = sha1(realpath).slice(0,12)`.
2. Start serving stdio **immediately**: answer `server/discover`/`initialize`/`tools/list` from a static manifest; `graph_status` returns `{state:"attaching"|"starting"|"indexing"|"ready"|"error", progress, engineVersion}`. Do not block the handshake on the engine (Codex 10 s cap).
3. Read `.cpg/engine.json` `{pid, startTime, version, protocol, ipc:{kind:"unix"|"pipe"|"tcp", path|port, token}, workspaceRoot, startedAt}`. Treat as **stale** if: file absent/unparsable; `pid` not alive (`process.kill(pid,0)`); recorded `startTime` ≠ live process start time; `workspaceRoot` mismatch; or a connect to `ipc` fails within 500 ms.
4. If live: connect, send `engine/hello {shimVersion, protocol}`; on `versionMismatch` treat as stale (Nx pattern) and prefer restarting the engine only if it is idle (no other shims attached — engine reports `clients` count); otherwise keep serving with a `graph_status` warning.
5. If stale: acquire `.cpg/engine.lock` with `O_EXCL` (retry 5×/200 ms; if lock exists and its pid is dead, remove); spawn `cpg engine --workspace <root>` detached, stdio → `.cpg/logs/engine.log`, `unref()`; engine writes `engine.json` atomically (tmp + rename) after binding; poll connect every 100 ms up to 30 s; release lock.
6. IPC: Unix socket at `${XDG_RUNTIME_DIR||/tmp}/cpg/${wsHash}.sock` (≤80 chars — do **not** use macOS `$TMPDIR`); Windows `\\.\pipe\cpg-${wsHash}`; `CPG_SOCKET_DIR` override; fall back to `127.0.0.1:<ephemeral>` + token when path too long.
7. Forward tool calls as NDJSON with a per-call deadline (default 25 s, below Codex 60 s); on engine disconnect mid-call, re-probe once, replay, else `isError:"engine restarted; retry"`.
8. Engine exits after idle (e.g. 30 min with zero shims) and removes `engine.json`; shims exit on stdin EOF.

**Host config snippets to generate (`cpg mcp install --host <x>`):**
- Claude Code `.mcp.json`: `{"mcpServers":{"cpg":{"type":"stdio","command":"cpg","args":["mcp","--workspace","${CLAUDE_PROJECT_DIR:-.}"],"timeout":60000}}}`
- Cursor `.cursor/mcp.json`: `{"mcpServers":{"cpg":{"type":"stdio","command":"cpg","args":["mcp","--workspace","${workspaceFolder}"]}}}`
- VS Code `.vscode/mcp.json`: `{"servers":{"cpg":{"type":"stdio","command":"cpg","args":["mcp","--workspace","${workspaceFolder}"],"cwd":"${workspaceFolder}"}}}` (plus extension-registered definition, preferred)
- Codex `.codex/config.toml`: `[mcp_servers.cpg] command="cpg" args=["mcp"] cwd="<abs root>" startup_timeout_sec=20 tool_timeout_sec=60`
- Windsurf/JetBrains: Claude-Desktop shape with an **absolute** `--workspace` (no variable support).

**Spike list.**
1. Dual-era smoke test: SDK v2 `serveStdio` against today's Claude Code, Cursor, VS Code, Codex (legacy `initialize`) and the v2 `@modelcontextprotocol/client` (modern).
2. Measure spawn cwd + env in each host by logging `process.cwd()`, `CLAUDE_PROJECT_DIR`, argv to stderr.
3. `GRAPH.RO_QUERY` behaviour with `CALL db.idx.fulltext.createNodeIndex(...)`, `MERGE` inside `FOREACH`, and confirm exact `TIMEOUT` argument syntax/error text on the FalkorDB version we pin; check whether FalkorDB honours Redis ACL command rules.
4. Socket-path length on macOS with deep workspace paths; Windows named pipe via Node `net`.
5. Stale-lock chaos test: kill -9 engine, PID reuse simulation, two shims racing to start.
6. Token-budget A/B: Markdown-table vs JSON `content` for `callers_of` on Claude Code and Cursor; pick default `response_format`.
7. Verify Cursor's active-tool cap empirically with our 11 tools plus two other common servers.

## Sources (accessed 2026-09-11)

- MCP 2026-07-28 changelog — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP transports overview — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- MCP stdio binding — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- MCP versioning / dual-era compatibility — https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- MCP tools — https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP release-candidate blog — https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- TypeScript SDK releases (atom) — https://github.com/modelcontextprotocol/typescript-sdk/releases.atom
- SDK v2 migration: support-2026-07-28 — https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/migration/support-2026-07-28.md
- npm registry `@modelcontextprotocol/server@2.0.0` — https://registry.npmjs.org/@modelcontextprotocol/server/latest
- npm registry `@modelcontextprotocol/sdk@1.30.0` — https://registry.npmjs.org/@modelcontextprotocol/sdk/latest
- SDK docs via Context7 (`/modelcontextprotocol/typescript-sdk`: docs/serving/stdio.md, docs/servers/tools.md, docs/servers/resources.md, docs/servers/notifications.md)
- Claude Code MCP docs — https://code.claude.com/docs/en/mcp
- Claude Code Tool Search issue #18298 — https://github.com/anthropics/claude-code/issues/18298
- Claude Code daemon.lock stale-PID issue #72898 — https://github.com/anthropics/claude-code/issues/72898
- Claude Code socket-path issue #17658 — https://github.com/anthropics/claude-code/issues/17658
- Cursor MCP docs — https://cursor.com/docs/context/mcp
- Cursor forum: tool limit — https://forum.cursor.com/t/tools-limited-to-40-total/67976 ; cwd — https://forum.cursor.com/t/how-get-the-correct-current-work-directory-in-mcp-server/99215
- VS Code MCP configuration reference — https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- VS Code MCP extension guide — https://code.visualstudio.com/api/extension-guides/ai/mcp
- VS Code 128-tool limit issue — https://github.com/microsoft/vscode/issues/290356 ; virtual tools — https://code.visualstudio.com/updates/v1_103
- Codex config reference — https://learn.chatgpt.com/docs/config-file/config-reference (redirect from developers.openai.com/codex/config-reference)
- OpenAI function-calling guide — https://developers.openai.com/api/docs/guides/function-calling
- Windsurf/Cascade MCP docs — https://docs.devin.ai/desktop/cascade/mcp (redirect from docs.windsurf.com)
- JetBrains AI Assistant MCP — https://www.jetbrains.com/help/ai-assistant/mcp.html
- Cline cwd=/ issue — https://github.com/cline/cline/issues/9950 ; Qoder report — https://forum.qoder.com/t/mcp-stdio-servers-are-spawned-with-cwd-and-no-roots-capability-breaking-workspace-aware-servers/11828
- Anthropic, Writing effective tools for agents — https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic Tool Search tool docs — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- SEP-986 tool name format — https://modelcontextprotocol.io/seps/986-specify-format-for-tool-names
- Format-effectiveness study — https://arxiv.org/pdf/2602.05447 ; chunkhound JSON→Markdown — https://github.com/chunkhound/chunkhound/issues/173 ; SEP-1624 — https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1624
- Neo4j production-proofing — https://neo4j.com/blog/developer/production-proofing-cypher-mcp-server/ ; mcp-neo4j README — https://github.com/neo4j-contrib/mcp-neo4j/blob/main/servers/mcp-neo4j-cypher/README.md
- Memgraph MCP — https://memgraph.com/docs/ai-ecosystem/mcp
- FalkorDB MCP server — https://github.com/FalkorDB/FalkorDB-MCPServer
- GitHub MCP toolsets — https://github.com/github/github-mcp-server ; changelog — https://github.blog/changelog/2025-12-10-the-github-mcp-server-adds-support-for-tool-specific-configuration-and-more/
- Sourcegraph curated default tools — https://sourcegraph.com/changelog/mcp-curated-default-tools
- Serena tools — https://oraios.github.io/serena/01-about/035_tools.html
- Context7 MCP — https://github.com/mcp/upstash/context7
- Nx daemon socket-utils — https://raw.githubusercontent.com/nrwl/nx/master/packages/nx/src/daemon/socket-utils.ts ; client — https://raw.githubusercontent.com/nrwl/nx/master/packages/nx/src/daemon/client/client.ts
- Docker MCP Gateway — https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/
- mcp-proxy — https://github.com/sparfenyuk/mcp-proxy
- macOS sun_path 104 — https://github.com/dotnet/runtime/issues/79503 ; https://github.com/microsoft/vscode-remote-release/issues/11677
- FalkorDB GRAPH.RO_QUERY — https://docs.falkordb.com/commands/graph.ro-query ; GRAPH.QUERY — https://docs.falkordb.com/commands/graph.query.html ; configuration — https://docs.falkordb.com/getting-started/configuration.html ; default TIMEOUT issue #1826 — https://github.com/FalkorDB/FalkorDB/issues/1826
