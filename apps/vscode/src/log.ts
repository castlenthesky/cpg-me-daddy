// REAL: the extension's log, in plain node. extension.ts gives it VS Code's LogOutputChannel ("CPG" in
// the Output panel, or "CPG: Show Log"), which timestamps each line, filters by the level the user picks
// ("Developer: Set Log Level..."), and prints an Error's stack.

/** The part of vscode.LogOutputChannel the extension writes to. */
export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(error: string | Error, ...args: unknown[]): void;
}

const ignore = (): void => undefined;

/** Writes nothing: the default where no channel is given (tests). */
export const silentLogger: Logger = {
  trace: ignore,
  debug: ignore,
  info: ignore,
  warn: ignore,
  error: ignore,
};

/** A thrown value as an Error, so the channel prints its stack; a non-Error becomes its string. */
export function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/** Milliseconds since `start` (a performance.now() reading), to one decimal. */
export function elapsed(start: number): string {
  return (performance.now() - start).toFixed(1);
}
