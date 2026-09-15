"""Build a JSON representation of a directory tree (like `tree`, but JSON).

Usage:
    uv run dir_tree.py [path] [output.json] [--exclude name ...]

    path defaults to "src". If output.json is omitted, prints to stdout.
    --exclude takes one or more directory/file names to skip (in addition to
    the defaults below), e.g. --exclude __pycache__ .venv
"""

import json
import pathlib
import sys

DEFAULT_EXCLUDES = {
    "__pycache__",
    ".venv",
    ".git",
    "node_modules",
    ".DS_Store",
    ".pytest_cache",
    ".mypy_cache",
    "dist",
}


def build_tree(path: pathlib.Path, exclude: set[str], rel_to: pathlib.Path) -> dict:
    node = {
        "name": path.name,
        "type": "directory" if path.is_dir() else "file",
        "path": str(path.relative_to(rel_to)),
    }
    if path.is_dir():
        node["children"] = [
            build_tree(child, exclude, rel_to)
            for child in sorted(path.iterdir(), key=lambda p: p.name)
            if child.name not in exclude
        ]
    return node


def parse_args(argv: list[str]) -> tuple[list[str], set[str]]:
    positional = []
    exclude = set(DEFAULT_EXCLUDES)
    i = 0
    while i < len(argv):
        if argv[i] == "--exclude":
            i += 1
            while i < len(argv) and argv[i] != "--exclude":
                exclude.add(argv[i])
                i += 1
            continue
        positional.append(argv[i])
        i += 1
    return positional, exclude


def main() -> None:
    positional, exclude = parse_args(sys.argv[1:])
    root = pathlib.Path(positional[0] if positional else "src").resolve()
    output_path = positional[1] if len(positional) > 1 else None

    tree = build_tree(root, exclude, rel_to=root.parent)
    output = json.dumps(tree, indent=2)

    if output_path:
        pathlib.Path(output_path).write_text(output + "\n")
        print(f"Wrote tree for {root} -> {output_path}")
    else:
        print(output)


if __name__ == "__main__":
    main()
