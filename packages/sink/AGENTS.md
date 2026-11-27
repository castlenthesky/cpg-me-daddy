# packages/sink: agent notes

Status: the C-SINK types and MemoryStore, both halves: the GraphSink (U2a.2b) and the GraphStore (U2a.2c),
whose replace-file and delete-file are `file-writes.ts` (U6a.3-1, controller decisions 97 and 98), and
`nextWriteSeq()`, the code tier's write seq (U6a.3-2, decision 98a: SINK is the one allocator).
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O.
