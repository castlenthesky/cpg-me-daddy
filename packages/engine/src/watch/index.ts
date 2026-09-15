export * from "./backend";
export * from "./debounce";
export * from "./events";
export * from "./normalize";
export * from "./queue";
export * from "./sink";
export * from "./watch-workspace";

// `parcel-backend.ts` is deliberately NOT re-exported here — importing this
// barrel (or `@cpg/engine`) must never pull in the native `@parcel/watcher`
// module. `watch-workspace.ts` imports it directly, lazily, only when
// `watchWorkspace` actually runs.
