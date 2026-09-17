import { appendFileSync, mkdirSync } from "node:fs";
import { paths } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = order.info;
let fileEnabled = true;

export function configureLogger(level: LogLevel): void {
  threshold = order[level];
}

function writeFile(line: string): void {
  if (!fileEnabled) return;
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    appendFileSync(paths.logFile, line);
  } catch {
    // Read-only media and the like: give up on the file and keep using stderr.
    fileEnabled = false;
  }
}

/**
 * stdout belongs to the MCP JSON-RPC stream. Logs only ever go to stderr and the log file.
 */
function emit(level: LogLevel, message: string, detail?: unknown): void {
  const timestamp = new Date().toISOString();
  const suffix = detail === undefined ? "" : ` ${safeStringify(detail)}`;
  const line = `${timestamp} [${level}] ${message}${suffix}\n`;

  writeFile(line);
  if (order[level] >= threshold) process.stderr.write(line);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => emit("debug", message, detail),
  info: (message: string, detail?: unknown) => emit("info", message, detail),
  warn: (message: string, detail?: unknown) => emit("warn", message, detail),
  error: (message: string, detail?: unknown) => emit("error", message, detail),
  /** Verbatim relay of llama-server output; no level filtering. */
  raw: (message: string) => {
    const line = `${new Date().toISOString()} [llama] ${message}\n`;
    writeFile(line);
    if (order.debug >= threshold) process.stderr.write(line);
  },
};
