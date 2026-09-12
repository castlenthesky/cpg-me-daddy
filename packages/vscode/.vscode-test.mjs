import { defineConfig } from "@vscode/test-cli";

// Extension-host tests are introduced by unit M3; this config exists from F1 so
// the runner is wired and the package layout does not have to change later.
export default defineConfig({
  files: "dist/test/**/*.test.js",
  version: "stable",
  workspaceFolder: ".",
  mocha: {
    ui: "tdd",
    timeout: 20000,
  },
});
