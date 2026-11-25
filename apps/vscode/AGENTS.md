# apps/vscode: agent notes

Status (U3.1.1 part 2, BMO-52): REAL: C-EXT's host types (`contract.ts`), `PanelGraphHost` (`graph-host.ts`, plain node: merged payload, epoch, ready and resync answers, theme, latest render-report, recorded `ProtocolFault`s, `reveal` and `verify`), `verifyPayload` (`verify-payload.ts`), `VerifyScheduler` (`verify-scheduler.ts`), and the status and diagnostics data (`verification-view.ts`). Nothing composes the host, or calls the scheduler or the view yet: `extension.ts` is still the W0 smoke command until part 4, and nothing produces deltas before U4, so `onDelta` has tests and no product caller (controller decision 28). The inbound parser is a constructor dependency until `@cpg/inspector` has a front door (part 3).
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- The only place `vscode` may be imported. Imports `@cpg/*` front doors only.
