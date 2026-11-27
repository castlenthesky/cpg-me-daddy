# @cpg/extract

Pipeline stage 3. Walks one file's syntax tree through its language's `LanguageAdapter` and returns an `ExtractedFile`: file-owned nodes, SYMBOLs in their own channel, edges and ref sites, with stable ids and no cross-file knowledge. The types are in `src/contract.ts` (C-EXTRACT); the extractor itself is not built yet.
