/**
 * Injected I/O so every command is testable by capturing strings instead of
 * patching `process.stdout`/`process.stderr`.
 */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function processIo(): Io {
  return {
    out(line: string): void {
      process.stdout.write(`${line}\n`);
    },
    err(line: string): void {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
  };
}

/** Captures output for tests instead of writing anywhere. */
export function captureIo(env: Readonly<Record<string, string | undefined>> = {}): Io & {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    out: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
    env,
    stdout,
    stderr,
  };
}
