// SEAT (U2b.1 part 3a-ii, BMO-35): the inspector process (owner decision 9a). NDJSON goes in on
// stdin, the picture is served on 127.0.0.1, and render-reports come out on stdout. main.ts runs it
// with the real streams.

/** Where text goes (process.stdout, process.stderr, or a test's buffer). */
export interface TextSink {
  write(text: string): unknown;
}

export interface InspectorOptions {
  /** NDJSON InspectorInput lines. Its end shuts the inspector down. */
  readonly stdin: NodeJS.ReadableStream;
  /** NDJSON: `{"type":"listening","url":"http://127.0.0.1:<port>/"}` first, then each render-report message. */
  readonly stdout: TextSink;
  /** Diagnostics, one `cpg-inspector: ` line each: bad stdin lines, host faults, server logs. */
  readonly stderr: TextSink;
  /** The page bundle the server serves. */
  readonly bundlePath: string;
}

/**
 * Starts the server and writes the listening line, then feeds each stdin line to the host. Lines
 * end at LF or CRLF, and a last line with no newline counts. A blank line is skipped. A line that is
 * not JSON (`stdin line <n>: not JSON`), or not an InspectorInput
 * (`stdin line <n>: not a graph, graph-delta or verification message`), goes to stderr with its
 * 1-based number, and reading goes on. Resolves once stdin has ended and the server has closed; a
 * stdin error closes the server and rejects with it.
 */
export function runInspector(_options: InspectorOptions): Promise<void> {
  throw new Error('SEAT: runInspector is U2b.1 part 3a-ii');
}
