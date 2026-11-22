#!/usr/bin/env node
// Runtime purity proof (U2c.3, BMO-48, CS-6). SEAT: the Module._load trap lands with U2c.3.

throw new Error('SEAT: tools/purity-proof.mjs lands with U2c.3 (BMO-48)');
