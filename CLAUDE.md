# cpg-me-daddy — agent instructions

- Read `docs/outline/README.md` first. `docs/outline/` is the only authoritative documentation.
- Never read the `docs/archive` branch, `archived/**`, or `.debate/`; they are retired history.
  If the outline lacks something you need, that is a defect in the outline — fix it there.
- Find work in `docs/outline/07-milestones.yaml`; check `02-decisions.yaml` before proposing changes.
- START SIMPLE. Do not generalize before the second concrete caller exists.
- Stub the whole shape first, compiling, each body labeled REAL, PASSTHROUGH or SEAT; then make one piece real at a time.
- The gate ships in the same PR as the code it gates. One unit, one branch, one PR, 200–500 reviewable lines.
- `packages/**` never imports a host SDK; `apps/<name>` imports only its own (`tools/check-deps.mjs`).
- Run `npm run verify` before pushing; CI is a second opinion.
