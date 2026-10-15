// Structured, dependency-free logging. One JSON object per line.
// createApp defaults to noopLogger (silent); src/index.ts injects jsonLogger().
// usage/context_ratio are null today: the chat path is a passthrough (F4 fills them).
export type LogLevel = "info" | "error";
export interface LogEvent { level: LogLevel; msg: string; [field: string]: unknown; }
export type Logger = (event: LogEvent) => void;
function writeStderr(line: string): void {
  // process.stderr, not a bare `stderr` global (does not exist in Bun 1.4.3 -> TS2304).
  process.stderr.write(`${line}\n`);
}
export function jsonLogger(write: (line: string) => void = writeStderr): Logger {
  return (event) => write(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}
export const noopLogger: Logger = () => {};
/** Never let a logging failure break a request. */
export function safeLog(logger: Logger, event: LogEvent): void {
  try { logger(event); } catch { /* ignore */ }
}
