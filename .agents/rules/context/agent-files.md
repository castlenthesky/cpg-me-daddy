---
name: agent-files
description: Guidance for effective CLAUDE.md files
trigger: auto
paths:
  - '**/AGENTS.md'
  - '**/CLAUDE.md'
---

- Symlink all `CLAUDE.md` to `AGENTS.md` in the same directory.
- Always symlink instead of reference via `@AGENTS.md`.
- Use `AGENTS.md` files to describe rules for a directory.
- Redirect human-guidance and usage instructions to README.md files. `AGENTS.md` should be reserved for instructions that guide agents on how to behave/develop within a directory.
