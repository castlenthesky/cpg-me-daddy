// REAL (U3.1.2, BMO-56): `bun run test:vscode-host`'s @vscode/test-cli configuration.

import { defineConfig } from '@vscode/test-cli';
import { hostConfigurations, scratchDirectory } from './vscode-host.mjs';

export default defineConfig(hostConfigurations(scratchDirectory()));
