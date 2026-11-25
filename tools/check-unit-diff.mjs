#!/usr/bin/env node
// SEAT (U3.1.1 part 1, controller decision 26): U3's machine gate, "the diff under packages/** is
// EMPTY for this unit (a CI check on the PR)" (BMO-18).
throw new Error('SEAT: check-unit-diff lands with U3.1.1 part 1');
