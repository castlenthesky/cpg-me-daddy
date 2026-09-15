"""Talk to the basedpyright language server over stdio to extract semantic
tokens, import origins, and references from a Python file.

This speaks the LSP wire protocol (Content-Length framed JSON-RPC) directly
against `basedpyright-langserver --stdio`, since there's no CLI flag for
"give me tokens/references" - that's LSP-only functionality.

Usage:
    uv run lsp_demo.py [path/to/file.py] [symbol_name]

    symbol_name is optional: if given, also looks up every reference to the
    first occurrence of that identifier in the file.
"""

import ast
import json
import pathlib
import subprocess
import sys
import threading
import urllib.parse


class LspClient:
    def __init__(self, cmd: list[str]) -> None:
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self._next_id = 1
        self._lock = threading.Lock()

    def _write(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        assert self.proc.stdin is not None
        self.proc.stdin.write(header + body)
        self.proc.stdin.flush()

    def _read_message(self) -> dict:
        assert self.proc.stdout is not None
        headers = {}
        while True:
            line = self.proc.stdout.readline().decode("ascii")
            if line in ("\r\n", ""):
                break
            name, value = line.strip().split(":", 1)
            headers[name.strip().lower()] = value.strip()
        length = int(headers["content-length"])
        body = self.proc.stdout.read(length)
        return json.loads(body)

    def request(self, method: str, params: dict) -> dict | None:
        with self._lock:
            msg_id = self._next_id
            self._next_id += 1
            self._write({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params})
            while True:
                message = self._read_message()
                if message.get("id") == msg_id:
                    if "error" in message:
                        raise RuntimeError(message["error"])
                    return message.get("result")
                # Ignore server->client requests/notifications (e.g. logs,
                # diagnostics) that arrive interleaved with our response.

    def notify(self, method: str, params: dict) -> None:
        with self._lock:
            self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def shutdown(self) -> None:
        try:
            self.request("shutdown", {})
            self.notify("exit", {})
        finally:
            self.proc.terminate()


def decode_semantic_tokens(data: list[int], legend: dict, source_lines: list[str]) -> list[dict]:
    """Decode the LSP semantic tokens delta-encoding into readable records."""
    token_types = legend["tokenTypes"]
    tokens = []
    line = 0
    char = 0
    for i in range(0, len(data), 5):
        delta_line, delta_start, length, type_idx, _modifiers = data[i : i + 5]
        line = line + delta_line
        char = char if delta_line else char
        char = char + delta_start if delta_line == 0 else delta_start
        text = source_lines[line][char : char + length]
        tokens.append(
            {
                "line": line + 1,
                "col": char,
                "text": text,
                "type": token_types[type_idx],
            }
        )
    return tokens


def find_imports(source: str) -> list[tuple[str, int, int]]:
    """Return (name, line, char) for each name bound by an import statement.

    Positions point at the imported name itself (not the module path or the
    `import` keyword), so they can be fed straight to textDocument/definition.
    """
    tree = ast.parse(source)
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                imports.append((alias.asname or alias.name, alias.lineno - 1, alias.col_offset))
    return imports


def uri_to_path(uri: str) -> pathlib.Path:
    return pathlib.Path(urllib.parse.urlparse(uri).path)


def describe_location(loc: dict, base_dir: pathlib.Path) -> str:
    uri = loc.get("uri") or loc.get("targetUri")
    rng = loc.get("range") or loc.get("targetRange")
    file_path = uri_to_path(uri)
    try:
        file_path = file_path.relative_to(base_dir)
    except ValueError:
        pass
    return f"{file_path}:{rng['start']['line'] + 1}:{rng['start']['character']}"


def find_symbol_position(tokens: list[dict], name: str) -> tuple[int, int] | None:
    """Position of the first token whose text matches `name` (0-indexed line)."""
    for tok in tokens:
        if tok["text"] == name:
            return tok["line"] - 1, tok["col"]
    return None


def main() -> None:
    path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "sample.py").resolve()
    symbol_name = sys.argv[2] if len(sys.argv) > 2 else None
    source = path.read_text()
    uri = path.as_uri()

    client = LspClient([".venv/bin/basedpyright-langserver", "--stdio"])

    init_result = client.request(
        "initialize",
        {
            "processId": None,
            "rootUri": path.parent.as_uri(),
            "capabilities": {
                "textDocument": {
                    "semanticTokens": {
                        "requests": {"full": True},
                        "tokenTypes": [],
                        "tokenModifiers": [],
                        "formats": ["relative"],
                    }
                }
            },
        },
    )
    assert init_result is not None
    client.notify("initialized", {})

    client.notify(
        "textDocument/didOpen",
        {
            "textDocument": {
                "uri": uri,
                "languageId": "python",
                "version": 1,
                "text": source,
            }
        },
    )

    # --- Semantic tokens ---
    legend = init_result["capabilities"]["semanticTokensProvider"]["legend"]
    tokens_result = client.request(
        "textDocument/semanticTokens/full",
        {"textDocument": {"uri": uri}},
    )
    assert tokens_result is not None
    source_lines = source.splitlines()
    tokens = decode_semantic_tokens(tokens_result["data"], legend, source_lines)

    print(f"--- Semantic tokens for {path.name} ({len(tokens)} tokens) ---")
    for tok in tokens:
        print(f"{tok['line']:>3}:{tok['col']:<3} {tok['type']:<12} {tok['text']!r}")

    # --- Import origins ---
    # For every name bound by an import statement, ask the server where that
    # name is actually defined (which file, which line).
    imports = find_imports(source)
    print(f"\n--- Import origins for {path.name} ({len(imports)} imports) ---")
    for name, line, char in imports:
        definitions = client.request(
            "textDocument/definition",
            {"textDocument": {"uri": uri}, "position": {"line": line, "character": char}},
        )
        locations = definitions if isinstance(definitions, list) else [definitions] if definitions else []
        if not locations:
            print(f"  {name:<20} -> <unresolved (stdlib/external stub or not found)>")
            continue
        for loc in locations:
            print(f"  {name:<20} -> {describe_location(loc, path.parent)}")

    # --- References ---
    # If a symbol name was given, find its first occurrence in the semantic
    # token stream and ask for every reference to it across the file.
    if symbol_name:
        position = find_symbol_position(tokens, symbol_name)
        if position is None:
            print(f"\n--- References to {symbol_name!r}: not found in {path.name} ---")
        else:
            target_line, target_char = position
            references = client.request(
                "textDocument/references",
                {
                    "textDocument": {"uri": uri},
                    "position": {"line": target_line, "character": target_char},
                    "context": {"includeDeclaration": True},
                },
            )

            print(f"\n--- References to {symbol_name!r} (first seen at line {target_line + 1}) ---")
            for ref in references or []:
                start = ref["range"]["start"]
                line_text = source_lines[start["line"]].strip()
                print(f"{start['line'] + 1}:{start['character']:<3} {line_text}")

    client.shutdown()


if __name__ == "__main__":
    main()
