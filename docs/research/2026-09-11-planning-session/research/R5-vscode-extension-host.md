# R5 — VS Code Extension Mechanics for the cpg-me-daddy Thin Host

*Research date: 2026-09-11. Target: VS Code ≥ 1.107, macOS + Linux. Claims are tagged **[VERIFIED]** (read in official docs or source today) or **[INFERENCE]** (my judgement from those facts).*

## Executive summary

- **Process model.** Every mainstream language extension (rust-analyzer, clangd, gopls, Nx Console) runs its server as a *per-window child* of the extension host via `vscode-languageclient`, killed on `deactivate`. None detach. gopls is the one precedent for a *shared daemon* (`gopls -remote=auto`, idle-shutdown after 1 min), but vscode-go does not enable it by default. For cpg-me-daddy the daemon should be a **fully detached process owned by the CLI**, discovered through `.cpg/engine.json`; the extension spawns it with `detached: true` only if nothing is listening, and never kills it on deactivate (idle timeout does that). This is the only model that satisfies "same daemon for CLI, MCP and N windows".
- **Binary acquisition.** Two conventions coexist: rust-analyzer *bundles* the server in **platform-specific VSIXes** (`vsce package --target`, 7 targets); clangd, Biome and ZLS *download at first run* into `globalStorageUri`. Only ZLS verifies (minisign); clangd verifies nothing and ignores proxies. No Marketplace policy forbids runtime downloads; the runtime-security doc explicitly says extensions may "run external processes" and make network requests. Recommendation: download FalkorDB at runtime, pinned by version + SHA-256 manifest embedded in the engine package, into a **user-level cache shared with the CLI**, with a `cpg.falkordb.path` escape hatch. Ship a single universal VSIX.
- **Views.** Webview views (`contributes.views` + `"type": "webview"`) can live in the Primary Sidebar and Panel and be *dragged* by the user to the Secondary Sidebar. They **cannot** be placed in the editor area, and extensions cannot contribute directly to the Secondary Sidebar (issue #198087 closed "not planned"). The "Graph as editor tab" requirement therefore needs a *second surface*: a `WebviewPanel` created by command, restored with a `WebviewPanelSerializer`. Both surfaces should be dumb renderers of one extension-side store fed by daemon events.
- **MCP.** `vscode.lm.registerMcpServerDefinitionProvider` + `contributes.mcpServerDefinitionProviders` is finalized (samples pin `engines.vscode ^1.101.0`); `McpStdioServerDefinition` supports `command/args/env/cwd/version`. Users see it in **MCP: List Servers** and the Extensions view, and get a trust dialog on first start. It is consumed by VS Code's built-in chat (Copilot agent mode); third-party agents in VS Code (Cline, Cursor, Claude Code) maintain their own MCP configs, so also emit a `.vscode/mcp.json` snippet / `cpg mcp --print-config`.
- **Packaging.** One esbuild config with two entry points (`extension.ts` → `dist/extension.js`, `cli.ts` → `dist/cli.js` with a shebang banner), `external: ['vscode']`, `platform: 'node'`, `format: 'cjs'`; `.wasm` grammars via the `copy` loader; **no native modules in the VSIX** (FalkorDB is a downloaded process, not a `.node` addon). Activate on `workspaceContains:**/cpg.config.yaml` + `onStartupFinished`. Engine is tested with plain Mocha/Vitest (no `vscode` import); the host with `@vscode/test-cli`.

---

## 1. Spawning and managing a long-lived daemon

**How the reference extensions do it [VERIFIED]**

| Extension | Mechanism | Detach? | Shutdown |
|---|---|---|---|
| rust-analyzer (`ctx.ts`) | `LanguageClient` with `Executable {command, options:{env}}`; version probe via `spawn(path, ['--version'])` | No | `client.stop(100)` then `dispose()` |
| vscode-clangd (`clangd-context.ts`) | `Executable {command, args, options:{cwd: rootPath, shell}}`; `createDefaultErrorHandler(restartAfterCrash ? 4 : 0)` | No | `client.stop()` in `dispose()` |
| vscode-go (`goLanguageServer.ts`) | `Executable {command: cfg.path, args: cfg.flags, options:{env}}`; up to 5 crash restarts with `restartHistory` | No | `c.stop(2000)` on deactivate |
| Nx Console | `LanguageClient` running `nxls/main.js` from the extension dir; the *Nx daemon* is a separate process owned by `nx`, not the extension | No (nxls) | terminates nxls "and any running graph servers" on deactivate |

`vscode-languageclient` (`client/src/node/main.ts`) spawns via `child_process`; `ExecutableOptions = { cwd, env, detached, shell }`; transports stdio / ipc / pipe / socket; on stop it waits 2 s then `process.kill`, **skipping the kill for detached processes**; and `ServerOptions` may be a function returning `Promise<StreamInfo>`, i.e. *attach to an already-running server over a socket*. **[VERIFIED]**

gopls daemon mode (`gopls/doc/daemon.md`) **[VERIFIED]**: each editor runs a thin forwarder (`gopls -remote=auto`) that auto-starts a shared daemon, connects (TCP or unix socket), forwards LSP, and the daemon "will automatically shut down after one minute with no connected clients" (`-remote.listen.timeout`). Rationale: cache sharing across windows.

`vscode.Task`/`ProcessExecution` run user-visible processes in the integrated terminal and are blocked in Restricted Mode; they are the wrong tool for a daemon. **[VERIFIED docs; INFERENCE on fit]**

Known pitfalls **[VERIFIED, GitHub issues]**: detached children are not reliably kept alive when the window closes unless stdio is not inherited (#90351); `deactivate` may not get time for async cleanup (#11895); killing an intermediate shell leaves grandchildren alive (#948).

**Answer [INFERENCE]:** the daemon should be a *fully detached* process that the CLI also uses. Extension flow: read `.cpg/engine.json` → check pid alive and `version` compatible → connect over the port (attach-if-running). Otherwise `spawn(cli, ['index','--daemon'], { detached: true, stdio: 'ignore' }).unref()` then poll for `engine.json`. Use a lockfile (`.cpg/engine.lock`) so two windows opening the same workspace at once don't race. On `deactivate` only close the socket; the daemon exits on idle timeout (gopls-style, default ~30 min, `cpg.daemon.idleTimeout`). Provide `cpg.daemon.stopOnLastWindowClose` for users who want the old behaviour. Gate spawning on `workspace.isTrusted` and declare `capabilities.untrustedWorkspaces: { supported: 'limited' }` because the daemon executes workspace-configured parsers. **[VERIFIED trust API]**

## 2. Native binary acquisition

**rust-analyzer [VERIFIED]** (`bootstrap.ts`, `release.yaml`): resolution order = `rust-analyzer.server.path` → `rust-toolchain` component → bundled `extensionUri/server/rust-analyzer[.exe]`. Release CI runs `npx vsce package … --target ${{ matrix.code-target }}` for `win32-x64, win32-arm64, linux-x64, linux-arm64, linux-armhf, darwin-x64, darwin-arm64` plus a `rust-analyzer-no-server.vsix`. NixOS: copies the bundled binary to `globalStorageUri` and `patchelf`s it. Every candidate is validated with `--version`. Downside noted in #11080: Open VSX mishandles platform VSIXes.

**clangd (`@clangd/install`) [VERIFIED]**: downloads from `api.github.com/repos/clangd/clangd/releases/latest` (5 s timeout) into `<globalStorage>/install/<version>/clangd_<version>/`; **no checksum or signature check; no proxy handling**; prompts Install / Update / reuse-existing; settings `clangd.path`, `clangd.checkUpdates`; installed version detected by parsing `clangd --version` and compared with semver.

**vscode-go [VERIFIED]**: does not download binaries; runs `go install <importPath>@<version>` in a temp module, versions pinned in `allToolsInformation.latestVersion`, update check via `go version -m` + `go.toolsManagement.autoUpdate`, override via `go.alternateTools`, proxy via `GOPROXY` env.

**vscode-zig (ZLS) [VERIFIED]**: queries `releases.zigtools.org/v1/zls/select-version?zig_version=`, stores under `globalStorageUri`, **verifies with minisign** (pinned public key; SHA-256 also supplied), caches the index in `globalState` for offline fallback, `zig.zls.path` / `zig.zls.enabled: on|off|ask`.

**Platform VSIX vs runtime download [INFERENCE from the above]**: platform VSIXes give offline installs and Marketplace-signed integrity but multiply publish artifacts, break Open VSX, and force a re-publish for every binary bump. Runtime download keeps one VSIX and decouples engine and DB versions but must implement verification, proxy, offline UX and a system-binary override. Both are conventional in 2026; the Marketplace docs contain **no policy** against runtime downloads and state extensions may "run external processes" **[VERIFIED]**. Proxy: read `http.proxy` / `http.proxyStrictSSL` from `workspace.getConfiguration` and honour `HTTPS_PROXY` **[INFERENCE — clangd omits this and gets bug reports]**.

## 3. Views: docked webview views vs editor-tab panels

**[VERIFIED]**
- `contributes.viewsContainers` accepts only `activitybar` and `panel`. `contributes.views` entries take `"type": "webview"` and are resolved by `window.registerWebviewViewProvider(id, provider, { webviewOptions: { retainContextWhenHidden } })`; `resolveWebviewView` receives `WebviewViewResolveContext.state` from `setState`. Since 1.74 no `onView:` activation event is needed.
- Users can drag views/containers between Primary Sidebar, Panel and Secondary Sidebar; extensions cannot contribute to the Secondary Sidebar (#198087 closed "not planned"). Neither the Custom Layout doc nor the Views UX guideline lists the editor area as a view location; the guideline says "Don't use an Activity Bar Item (View Container) to open a Webview in the Editor." Open bug #144122: you cannot drop another view into a container that holds only a webview view.
- `window.createWebviewPanel(viewType, title, ViewColumn, opts)` is the editor-area surface; persistence across restart via `registerWebviewPanelSerializer` + `onWebviewPanel:<viewType>` activation. `retainContextWhenHidden` has "high memory overhead"; `getState/setState` is the cheap path. Custom editors are for *file-backed* resources (`contributes.customEditors` with `selector` globs).
- `contributes.viewsWelcome` "only applies to empty tree views" — it does **not** render inside webview views.

**Pattern [INFERENCE]**: one `viewsContainer` (`cpg`, activitybar) holding four webview views: `cpg.graph`, `cpg.inspector`, `cpg.status`, `cpg.queryHistory`. Users relocate them freely (sidebar / panel / secondary sidebar). "Open Graph as Editor" command creates `WebviewPanel` `cpg.graphEditor` (serializer registered). Share state by keeping a single **extension-side store** (selection, focused node, query, viewport) fed by daemon events; both webviews receive the same `postMessage` diffs and post intents back — never webview-to-webview. Use `retainContextWhenHidden` only for the Graph (canvas/WebGL warm-up cost), `setState` for the others. Because `viewsWelcome` doesn't apply, render the first-run/“no index yet” state inside the Status webview itself. Skip `CustomEditor` unless you later want `.cpgquery` files to open as a graph.

## 4. Editor position tracking ("you are here")

**[VERIFIED]** `window.onDidChangeTextEditorSelection` (event has `kind: Keyboard | Mouse | Command`), `onDidChangeActiveTextEditor` (also fires with `undefined`), `onDidChangeTextEditorVisibleRanges`. Built-in breadcrumbs (`documentSymbolsOutline.ts`) build an `OutlineModel` from `languageFeaturesService.documentSymbolProvider`, debounce `onDidChangeCursorPosition` by **150 ms**, and pick the active symbol with `getItemEnclosingPosition(position)`. Extensions get the same data via `commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)`.

**[INFERENCE]** Mirror VS Code: debounce ~150 ms, drop events while the daemon is still indexing that file, resolve `{uri, line, col}` → CPG node via the daemon (authoritative), and fall back to / cross-check with `executeDocumentSymbolProvider` when the daemon has no node (unsupported language, stale index). Cache the symbol tree per document version to avoid re-querying on every keystroke.

## 5. MCP integration

**[VERIFIED]** `vscode.lm.registerMcpServerDefinitionProvider(id, { onDidChangeMcpServerDefinitions, provideMcpServerDefinitions, resolveMcpServerDefinition? })` requires a matching `contributes.mcpServerDefinitionProviders: [{ id, label }]`. `McpStdioServerDefinition` carries `label, command, args, env, version` and a `cwd: vscode.Uri`. Register **synchronously before `activate()` resolves** so VS Code can cache servers/tools without activating you; `resolveMcpServerDefinition` runs lazily at start (auth prompts go there). Proposal #243522 → milestone May 2025; 1.101 notes: "Extensions can now publish collections of MCP servers"; the official sample pins `engines.vscode ^1.101.0`. Users manage servers via **MCP: List Servers**, the Extensions view (gear icon), and a trust dialog on first start. `.vscode/mcp.json` uses `{ "servers": { name: { type: "stdio", command, args, env, envFile } }, "inputs": [...] }`; user-level file via **MCP: Open User Configuration**.

**Other agents [VERIFIED facts, INFERENCE on conclusion]**: the docs frame MCP purely inside Copilot agent mode; `vscode.lm.tools` did not surface MCP tools to other extensions until the Jan-2026 fix for #283959. Cursor does not implement this API (forum request). So the provider covers Copilot; for Cline/Claude Code/Cursor, offer `cpg mcp --print-config` and a "Copy MCP config" command.

## 6. Packaging, bundling, activation, testing

**[VERIFIED]** Official esbuild guidance: `entryPoints`, `bundle: true`, `format: 'cjs'`, `platform: 'node'`, `external: ['vscode']`, `sourcemap: !production`, `minify: production`, `tsc --noEmit` separately; `.vscodeignore` excludes `node_modules`/`src`. esbuild supports an array of entry points with `outdir`, a `copy` loader (static `.wasm`), `file`/`binary` loaders, and `banner: { js: '#!/usr/bin/env node' }`. Platform-specific VSIXes exist mainly for native node modules. Activation: `workspaceContains:**/cpg.config.yaml`, `onStartupFinished` (after all `*` extensions), `onWebviewPanel:<viewType>`; commands/views activate implicitly since 1.74. Multi-root: `workspace.workspaceFolders` (may be `undefined`), `getWorkspaceFolder(uri)`, `onDidChangeWorkspaceFolders`; the VS Code wiki recommends "a single server" over one per folder. Testing docs recommend `@vscode/test-cli` (`.vscode-test.mjs`, Extension Test Runner) on top of `@vscode/test-electron`.

**[INFERENCE]** Monorepo: `packages/engine` (pure TS, zero `vscode` imports, tested with Vitest/Mocha), `packages/cli` (thin), `packages/vscode` (esbuild bundles engine + cli entries; VSIX contains `dist/extension.js`, `dist/cli.js`, `grammars/*.wasm`). Keep `web-tree-sitter` (wasm) rather than native `tree-sitter` so the VSIX stays universal. Prefer `workspace.fs` for reads inside the extension but let the daemon do bulk I/O with Node `fs`. One daemon per *workspace folder* (matches `.cpg/engine.json` per repo); the extension holds N connections in a multi-root window.

## Recommendation for cpg-me-daddy

1. **Process model** — detached, CLI-owned daemon; extension = attach-or-spawn client; idle-timeout shutdown; lockfile against spawn races; trust-gated; `cpg doctor` reports stale `engine.json`.
2. **Binary acquisition** — runtime download of FalkorDB into a user-level cache **shared with the CLI** (`~/.cache/cpg/falkordb/<version>/`, override `CPG_CACHE_DIR`), SHA-256 manifest pinned in the engine package, proxy from `http.proxy`/env, offline → clear error + `cpg.falkordb.path` / `cpg.falkordb.remote` settings; universal VSIX. Revisit platform VSIXes only if download UX proves painful.
3. **Views** — one activity-bar container, four webview views, plus `cpg.graphEditor` WebviewPanel with serializer; single extension-side store; `retainContextWhenHidden` on Graph only.
4. **MCP** — register provider in `activate()` with `command: <path to cli.js runner>`, `args: ['mcp']`, `cwd: workspaceFolder.uri`, `version: engineVersion`; `cpg mcp` proxies stdio ↔ daemon so it stays lightweight; also emit `.vscode/mcp.json` snippet for non-Copilot agents.
5. **Packaging** — esbuild two entries, copy-loader wasm, no native deps, `workspaceContains` + `onStartupFinished`, `@vscode/test-cli` for host tests, plain runner for engine.

**Spike list** (each ≤ 1 day):
- S1: detached spawn survives *Developer: Reload Window* and window close on macOS + Linux; two windows attach to one daemon; lockfile race.
- S2: FalkorDB download + SHA-256 + launch from cache; confirm it is a single static binary vs `redis-server --loadmodule falkordb.so`; check macOS Gatekeeper behaviour for non-browser downloads.
- S3: webview view + WebviewPanel sharing one store; measure `retainContextWhenHidden` memory for the graph canvas; confirm drag to Secondary Sidebar/Panel.
- S4: MCP provider appears in *MCP: List Servers*, trust dialog, tool call round-trip; decide how `command` finds Node (`process.execPath` + `ELECTRON_RUN_AS_NODE=1` vs system `node`).
- S5: esbuild dual entry + wasm copy; `vsce package` size; `@vscode/test-cli` smoke test in CI with xvfb.
- S6: breadcrumb tracker at 150 ms debounce against daemon lookup latency; fallback to `executeDocumentSymbolProvider`.

## Sources (accessed 2026-09-11)

- MCP dev guide — https://code.visualstudio.com/api/extension-guides/ai/mcp
- MCP servers user doc — https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- 1.101 release notes — https://code.visualstudio.com/updates/v1_101
- MCP API proposal #243522 — https://github.com/microsoft/vscode/issues/243522
- `vscode.lm.tools` & MCP #283959 — https://github.com/microsoft/vscode/issues/283959
- MCP extension sample — https://github.com/microsoft/vscode-extension-samples/tree/main/mcp-extension-sample
- Webview API guide — https://code.visualstudio.com/api/extension-guides/webview
- Webview view sample — https://github.com/microsoft/vscode-extension-samples/tree/main/webview-view-sample
- Custom editors — https://code.visualstudio.com/api/extension-guides/custom-editors
- Contribution points — https://code.visualstudio.com/api/references/contribution-points
- VS Code API reference — https://code.visualstudio.com/api/references/vscode-api
- Views UX guideline — https://code.visualstudio.com/api/ux-guidelines/views
- Custom layout — https://code.visualstudio.com/docs/configure/custom-layout
- Secondary sidebar contribution #198087 — https://github.com/microsoft/vscode/issues/198087
- Webview-only container drag bug #144122 — https://github.com/microsoft/vscode/issues/144122
- Activation events — https://code.visualstudio.com/api/references/activation-events
- Workspace Trust guide — https://code.visualstudio.com/api/extension-guides/workspace-trust
- Multi-root APIs wiki — https://github.com/microsoft/vscode/wiki/Adopting-Multi-Root-Workspace-APIs
- Bundling with esbuild — https://code.visualstudio.com/api/working-with-extensions/bundling-extension
- Publishing / platform-specific — https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Testing extensions — https://code.visualstudio.com/api/working-with-extensions/testing-extension
- Extension runtime security — https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
- Task provider guide — https://code.visualstudio.com/api/extension-guides/task-provider
- esbuild API — https://esbuild.github.io/api/
- rust-analyzer `bootstrap.ts` / `ctx.ts` / `release.yaml` — https://github.com/rust-lang/rust-analyzer/tree/master/editors/code/src , https://github.com/rust-lang/rust-analyzer/blob/master/.github/workflows/release.yaml
- rust-analyzer Open VSX issue #11080 — https://github.com/rust-lang/rust-analyzer/issues/11080
- `@clangd/install` — https://github.com/clangd/node-clangd/blob/master/src/index.ts
- vscode-clangd `clangd-context.ts` — https://github.com/clangd/vscode-clangd/blob/master/src/clangd-context.ts
- vscode-go `goInstallTools.ts`, `goLanguageServer.ts` — https://github.com/golang/vscode-go/tree/master/extension/src
- gopls daemon mode — https://github.com/golang/tools/blob/master/gopls/doc/daemon.md
- vscode-zig `zls.ts` — https://github.com/ziglang/vscode-zig/blob/master/src/zls.ts
- vscode-languageclient node main — https://github.com/microsoft/vscode-languageserver-node/blob/main/client/src/node/main.ts
- Nx Console architecture — https://deepwiki.com/nrwl/nx-console/2.1-vscode-extension
- Breadcrumbs source — https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/codeEditor/browser/outline/documentSymbolsOutline.ts
- Detached child issues — https://github.com/microsoft/vscode/issues/90351 , https://github.com/microsoft/vscode/issues/11895 , https://github.com/microsoft/vscode/issues/948
- Cursor lacks the MCP provider API — https://forum.cursor.com/t/support-vs-codes-register-mcp-server-definition-provider-api/133031
