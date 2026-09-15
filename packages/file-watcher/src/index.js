"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hello = hello;
exports.startFileWatcher = startFileWatcher;
const node_fs_1 = require("node:fs");
function hello() {
    console.log('hello from file-watcher');
}
/**
 * Watches `rootPath` recursively and fires the (stubbed) orchestration
 * hook on every file change. Purely event-driven — fs.watch never blocks
 * the caller, so activation stays non-blocking.
 */
function startFileWatcher(rootPath) {
    return (0, node_fs_1.watch)(rootPath, { recursive: true }, () => {
        hello();
    });
}
//# sourceMappingURL=index.js.map