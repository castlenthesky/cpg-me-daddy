# @cpg/extract

Pipeline stage 3. Walks one file's syntax tree through its language's `LanguageAdapter` and returns an `ExtractedFile`: file-owned nodes, SYMBOLs in their own channel, edges and ref sites, with stable ids and no cross-file knowledge. The types are in `src/contract.ts` (C-EXTRACT). `createExtractor()` handles Python files and emits the MODULE tier so far (a MODULE, its SYMBOL and DEFINES); declarations, calls and imports land in later units. `sealExtractedFiles` seals a set of extracted files for resolution.
