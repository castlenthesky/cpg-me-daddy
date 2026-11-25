// REAL (U3.1.2, BMO-56): `bun run spike:vscode-host`'s @vscode/test-cli configuration.

import { defineConfig } from '@vscode/test-cli';
import { scratchDirectory, spikeConfiguration } from './vscode-host.mjs';

export default defineConfig(spikeConfiguration(scratchDirectory()));
