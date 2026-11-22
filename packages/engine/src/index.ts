export { DEFAULT_EXCLUDES, DEFAULT_INCLUDES, DEFAULT_MAX_FILE_SIZE_BYTES } from './walker/defaults';
export { compileMatcher } from './walker/glob';
export type { PathMatcher } from './walker/glob';
export { walkWorkspace } from './walker/walker';
export type {
  WalkedDirectory,
  WalkedFile,
  WalkOptions,
  WalkResult,
  WalkStats,
} from './walker/walker';
export { filesystemTier } from './walker/filesystem-tier';
export type { FilesystemTier } from './walker/filesystem-tier';
export { createEngine } from './engine';
export type { EngineConfig, EngineDeps, EngineSink } from './engine';
export { worstState } from './verify';
export type * from './port';
export { CONFIG_PRECEDENCE, ConfigError, resolveConfig, toCpgConfigInput } from './config/resolve';
export {
  CONFIG_FILE_NAME,
  configFileLayer,
  parseConfigFile,
  stringifyConfigFile,
} from './config/file';
export type { CpgConfigFile } from './config/file';
