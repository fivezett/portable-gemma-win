import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the application root (the folder you carry around).
 *
 * - GEMMA_HOME wins when set.
 * - When launched from an executable built with `bun build --compile`,
 *   it is the folder containing that executable.
 * - During development (`bun run src/index.ts`) it is the repository root.
 */
function detectAppRoot(): string {
  const fromEnv = process.env.GEMMA_HOME;
  if (fromEnv && fromEnv.trim() !== "") return resolve(fromEnv);

  const exe = process.execPath;
  const exeName = basename(exe).toLowerCase().replace(/\.exe$/, "");
  const runningUnderInterpreter = exeName === "bun" || exeName === "bun-debug" || exeName === "node";
  if (!runningUnderInterpreter) return dirname(exe);

  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const appRoot: string = detectAppRoot();

export const paths = {
  root: appRoot,
  /** llama.cpp Windows binaries and the bundled CUDA DLLs */
  runtimeDir: join(appRoot, "runtime", "llama"),
  /** GGUF storage, passed to llama.cpp as LLAMA_CACHE */
  modelsDir: join(appRoot, "models"),
  configDir: join(appRoot, "config"),
  configFile: join(appRoot, "config", "gemma.toml"),
  logsDir: join(appRoot, "logs"),
  logFile: join(appRoot, "logs", "gemma-mcp.log"),
} as const;

export const isWindows: boolean = process.platform === "win32";

/** Platform-specific binary name, so the code can also be exercised on Linux. */
export function serverBinaryName(): string {
  return isWindows ? "llama-server.exe" : "llama-server";
}
