import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { paths, serverBinaryName } from "./paths.ts";

export type Config = {
  server: {
    host: string;
    port: number;
    /** 既に llama-server が動いていない場合に自動起動するか */
    autostart: boolean;
    /** llama-server.exe のパス(既定は runtime/llama/) */
    binary: string;
    /** llama-server の WebUI を有効にするか */
    webui: boolean;
    /** llama-server に要求する API キー(空なら無し) */
    apiKey: string;
    /** 同時処理スロット数 */
    parallel: number;
  };
  model: {
    /** Hugging Face 指定。例: unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL */
    hf: string;
    /** ローカル GGUF のパス。指定されていれば hf より優先 */
    path: string;
    /** マルチモーダル用 projector。空なら llama.cpp の自動解決に任せる */
    mmproj: string;
    /** 表示名 (llama-server の --alias) */
    alias: string;
  };
  runtime: {
    ctx: number;
    ngl: number;
    flashAttn: "on" | "off" | "auto";
    /** llama-server にそのまま渡す追加引数 */
    extraArgs: string[];
  };
  sampling: {
    temperature: number;
    topP: number;
    topK: number;
    maxTokens: number;
  };
  timeouts: {
    /** 起動〜/health が ok になるまで。初回はモデル DL を含むので長め */
    startupMs: number;
    /** 1 リクエストあたりの上限 */
    requestMs: number;
  };
  log: {
    level: "debug" | "info" | "warn" | "error";
    /** llama-server の stdout/stderr をログに転記するか */
    llamaOutput: boolean;
  };
};

const defaults: Config = {
  server: {
    host: "127.0.0.1",
    port: 18080,
    autostart: true,
    binary: "",
    webui: true,
    apiKey: "",
    parallel: 1,
  },
  model: {
    hf: "unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL",
    path: "",
    mmproj: "",
    alias: "gemma",
  },
  runtime: {
    ctx: 16384,
    ngl: 99,
    flashAttn: "on",
    extraArgs: [],
  },
  sampling: {
    temperature: 1.0,
    topP: 0.95,
    topK: 64,
    maxTokens: 2048,
  },
  timeouts: {
    startupMs: 900_000,
    requestMs: 600_000,
  },
  log: {
    level: "info",
    llamaOutput: true,
  },
};

type Raw = Record<string, unknown>;

function section(raw: Raw, name: string): Raw {
  const value = raw[name];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase() as T;
    if (allowed.includes(normalized)) return normalized;
  }
  return fallback;
}

/**
 * 追加引数の文字列を分割する。引用符で囲まれた区間は 1 引数として扱う。
 * 例: `--override-kv "tokenizer.ggml.add_bos=bool:false" -np 2`
 */
export function splitArgs(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((v): v is string => typeof v === "string");
  if (typeof input !== "string" || input.trim() === "") return [];

  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent || current !== "") out.push(current);
      current = "";
      hasContent = false;
      continue;
    }
    current += char;
  }
  if (hasContent || current !== "") out.push(current);
  return out;
}

function readToml(file: string): Raw {
  if (!existsSync(file)) return {};
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Raw) : {};
  } catch (error) {
    // 設定ファイルが壊れていても既定値で起動できるようにする。
    process.stderr.write(`[gemma-mcp] config parse failed (${file}): ${String(error)}\n`);
    return {};
  }
}

/** 相対パスはアプリのルート基準で解決する */
function resolveFromRoot(value: string): string {
  if (value === "") return "";
  return isAbsolute(value) ? value : resolve(paths.root, value);
}

export function loadConfig(file: string = paths.configFile): Config {
  const raw = readToml(file);
  const env = process.env;

  const s = section(raw, "server");
  const m = section(raw, "model");
  const r = section(raw, "runtime");
  const p = section(raw, "sampling");
  const t = section(raw, "timeouts");
  const l = section(raw, "log");

  const binary = str(env.GEMMA_SERVER_BIN ?? s.binary, defaults.server.binary);

  return {
    server: {
      host: str(env.GEMMA_HOST ?? s.host, defaults.server.host),
      port: num(env.GEMMA_PORT ?? s.port, defaults.server.port),
      autostart: bool(env.GEMMA_AUTOSTART ?? s.autostart, defaults.server.autostart),
      binary: binary === "" ? join(paths.runtimeDir, serverBinaryName()) : resolveFromRoot(binary),
      webui: bool(env.GEMMA_WEBUI ?? s.webui, defaults.server.webui),
      apiKey: str(env.GEMMA_API_KEY ?? s.api_key, defaults.server.apiKey),
      parallel: num(env.GEMMA_PARALLEL ?? s.parallel, defaults.server.parallel),
    },
    model: {
      hf: str(env.GEMMA_MODEL_HF ?? m.hf, defaults.model.hf),
      path: resolveFromRoot(str(env.GEMMA_MODEL_PATH ?? m.path, defaults.model.path)),
      mmproj: resolveFromRoot(str(env.GEMMA_MMPROJ ?? m.mmproj, defaults.model.mmproj)),
      alias: str(env.GEMMA_ALIAS ?? m.alias, defaults.model.alias),
    },
    runtime: {
      ctx: num(env.GEMMA_CTX ?? r.ctx, defaults.runtime.ctx),
      ngl: num(env.GEMMA_NGL ?? r.ngl, defaults.runtime.ngl),
      flashAttn: oneOf(env.GEMMA_FLASH_ATTN ?? r.flash_attn, ["on", "off", "auto"] as const, defaults.runtime.flashAttn),
      extraArgs: splitArgs(env.GEMMA_EXTRA_ARGS ?? r.extra_args),
    },
    sampling: {
      temperature: num(env.GEMMA_TEMPERATURE ?? p.temperature, defaults.sampling.temperature),
      topP: num(env.GEMMA_TOP_P ?? p.top_p, defaults.sampling.topP),
      topK: num(env.GEMMA_TOP_K ?? p.top_k, defaults.sampling.topK),
      maxTokens: num(env.GEMMA_MAX_TOKENS ?? p.max_tokens, defaults.sampling.maxTokens),
    },
    timeouts: {
      startupMs: num(env.GEMMA_STARTUP_TIMEOUT_MS ?? t.startup_ms, defaults.timeouts.startupMs),
      requestMs: num(env.GEMMA_REQUEST_TIMEOUT_MS ?? t.request_ms, defaults.timeouts.requestMs),
    },
    log: {
      level: oneOf(env.GEMMA_LOG_LEVEL ?? l.level, ["debug", "info", "warn", "error"] as const, defaults.log.level),
      llamaOutput: bool(env.GEMMA_LOG_LLAMA ?? l.llama_output, defaults.log.llamaOutput),
    },
  };
}

export function baseUrl(config: Config): string {
  return `http://${config.server.host}:${config.server.port}`;
}

export { defaults as defaultConfig };
