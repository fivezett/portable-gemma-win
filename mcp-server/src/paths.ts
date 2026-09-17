import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * アプリのルート(= 持ち運ぶフォルダ)を解決する。
 *
 * - GEMMA_HOME が指定されていればそれを最優先
 * - bun build --compile した exe から起動された場合は exe のあるフォルダ
 * - `bun run src/index.ts` の開発実行では mcp-server/ の親 (リポジトリルート)
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
  /** llama.cpp の Windows バイナリ一式 */
  runtimeDir: join(appRoot, "runtime", "llama"),
  /** GGUF の保存先。LLAMA_CACHE としてそのまま llama.cpp に渡す */
  modelsDir: join(appRoot, "models"),
  configDir: join(appRoot, "config"),
  configFile: join(appRoot, "config", "gemma.toml"),
  logsDir: join(appRoot, "logs"),
  logFile: join(appRoot, "logs", "gemma-mcp.log"),
} as const;

export const isWindows: boolean = process.platform === "win32";

/** 実行ファイル名は OS 依存にする (Linux 上でのテストを可能にするため) */
export function serverBinaryName(): string {
  return isWindows ? "llama-server.exe" : "llama-server";
}
