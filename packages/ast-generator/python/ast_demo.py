"""Parse a Python file with tree-sitter and print its AST.

Usage:
    uv run ast_demo.py [path/to/file.py]
"""

import sys

import tree_sitter_python as tspython
from tree_sitter import Language, Parser

PY_LANGUAGE = Language(tspython.language())


def print_tree(node, source: bytes, indent: int = 0) -> None:
    text = source[node.start_byte : node.end_byte]
    if not node.child_count:
        snippet = text.decode("utf-8", errors="replace")
        snippet = snippet if len(snippet) <= 40 else snippet[:37] + "..."
        print(f"{'  ' * indent}{node.type} [{node.start_point} - {node.end_point}] {snippet!r}")
    else:
        print(f"{'  ' * indent}{node.type} [{node.start_point} - {node.end_point}]")

    for child in node.children:
        print_tree(child, source, indent + 1)


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "sample.py"
    source = open(path, "rb").read()

    parser = Parser(PY_LANGUAGE)
    tree = parser.parse(source)

    print(f"--- AST for {path} ---")
    print_tree(tree.root_node, source)

    print("\n--- S-expression ---")
    print(tree.root_node)


if __name__ == "__main__":
    main()
