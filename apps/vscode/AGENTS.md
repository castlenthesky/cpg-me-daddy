# apps/vscode: agent notes

Status (U3.1.1 part 1, BMO-52): REAL: C-EXT's host types (`contract.ts`) and `PanelGraphHost` (`graph-host.ts`, plain node): the merged payload, the epoch, the ready and resync answers, the theme, the latest render-report and the recorded `ProtocolFault`s. SEAT: `reveal` and `verify` (part 2). Nothing composes the host yet: `extension.ts` is still the W0 smoke command until part 4, and nothing produces deltas before U4, so `onDelta` has tests and no product caller (controller decision 28). The inbound parser is a constructor dependency until `@cpg/inspector` has a front door (part 3).
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- The only place `vscode` may be imported. Imports `@cpg/*` front doors only.
