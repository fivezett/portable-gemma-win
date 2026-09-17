import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { paths, serverBinaryName } from "./paths.ts";

export type Config = {
  server: {
    host: string;
    port: number;
    /** Start llama-server on demand when nothing is answering yet */
    autostart: boolean;
    /** Path to llama-server.exe; defaults to runtime/llama/ */
    binary: string;
    /** Serve the llama.cpp web UI */
    webui: boolean;
    /** API key required by llama-server; empty disables it */
    apiKey: string;
    /** Number of parallel slots */
    parallel: number;
  };
  model: {
    /** Hugging Face spec, e.g. unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL */
    hf: string;
    /** Local GGUF path; takes precedence over `hf` when set */
    path: string;
    /** Multimodal projector; empty lets llama.cpp resolve it */
    mmproj: string;
    /** Display name passed to llama-server as --alias */
    alias: string;
  };
  runtime: {
    /**
     * Which llama.cpp build to drive.
     *   cuda     - NVIDIA, the official prebuilt Windows binaries
     *   openvino - Intel CPU / GPU / NPU, built from source by this project's CI
     */
    backend: "cuda" | "openvino";
    ctx: number;
    ngl: number;
    flashAttn: "on" | "off" | "auto";
    /** Extra arguments forwarded to llama-server verbatim */
    extraArgs: string[];
  };
  openvino: {
    /** CPU, GPU, NPU, or an indexed device such as GPU.1 */
    device: string;
    /**
     * Stateful KV cache. Faster where it works, but Gemma 4 fails with it on CPU and GPU,
     * so it is off by default. It also limits llama-server to a single chat session.
     */
    stateful: boolean;
    /** Cache compiled models under cache/openvino. Ignored on NPU, which cannot use it. */
    cache: boolean;
    /** Token chunk size for NPU prefill; ignored on CPU and GPU */
    npuPrefillChunk: number;
  };
  sampling: {
    temperature: number;
    topP: number;
    topK: number;
    maxTokens: number;
  };
  timeouts: {
    /** Startup until /health returns ok; generous because the first run downloads the model */
    startupMs: number;
    /** Per-request ceiling */
    requestMs: number;
  };
  log: {
    level: "debug" | "info" | "warn" | "error";
    /** Relay llama-server stdout/stderr into the log file */
    llamaOutput: boolean;
  };
};

/**
 * Per-backend defaults. The CUDA and OpenVINO paths want different quantisations:
 * upstream validated the OpenVINO backend against plain Q4_K_M builds, while the
 * CUDA path does better on Unsloth's dynamic quants.
 */
export const backendDefaults = {
  cuda: { modelHf: "unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL" },
  openvino: { modelHf: "bartowski/google_gemma-4-E4B-it-GGUF:Q4_K_M" },
} as const;

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
    hf: backendDefaults.cuda.modelHf,
    path: "",
    mmproj: "",
    alias: "gemma",
  },
  runtime: {
    backend: "cuda",
    ctx: 16384,
    ngl: 99,
    flashAttn: "on",
    extraArgs: [],
  },
  openvino: {
    // CPU always works. GPU and NPU are faster on Core Ultra but fail outright when absent,
    // so the safe device is the default and doctor points at the better one.
    device: "CPU",
    stateful: false,
    cache: true,
    npuPrefillChunk: 256,
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
 * Split an extra-argument string, keeping quoted spans as a single argument.
 * Example: `--override-kv "tokenizer.ggml.add_bos=bool:false" -np 2`
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
    // A broken config file must not stop the server from starting on defaults.
    process.stderr.write(`[gemma-mcp] config parse failed (${file}): ${String(error)}\n`);
    return {};
  }
}

/** Relative paths resolve against the application root. */
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
  const o = section(raw, "openvino");
  const p = section(raw, "sampling");
  const t = section(raw, "timeouts");
  const l = section(raw, "log");

  const backend = oneOf(env.GEMMA_BACKEND ?? r.backend, ["cuda", "openvino"] as const, defaults.runtime.backend);
  const binary = str(env.GEMMA_SERVER_BIN ?? s.binary, defaults.server.binary);
  const defaultRuntimeDir = backend === "openvino" ? paths.openvinoRuntimeDir : paths.runtimeDir;

  return {
    server: {
      host: str(env.GEMMA_HOST ?? s.host, defaults.server.host),
      port: num(env.GEMMA_PORT ?? s.port, defaults.server.port),
      autostart: bool(env.GEMMA_AUTOSTART ?? s.autostart, defaults.server.autostart),
      binary: binary === "" ? join(defaultRuntimeDir, serverBinaryName()) : resolveFromRoot(binary),
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
      backend,
      ctx: num(env.GEMMA_CTX ?? r.ctx, defaults.runtime.ctx),
      ngl: num(env.GEMMA_NGL ?? r.ngl, defaults.runtime.ngl),
      flashAttn: oneOf(env.GEMMA_FLASH_ATTN ?? r.flash_attn, ["on", "off", "auto"] as const, defaults.runtime.flashAttn),
      extraArgs: splitArgs(env.GEMMA_EXTRA_ARGS ?? r.extra_args),
    },
    openvino: {
      device: str(env.GEMMA_OPENVINO_DEVICE ?? o.device, defaults.openvino.device).toUpperCase(),
      stateful: bool(env.GEMMA_OPENVINO_STATEFUL ?? o.stateful, defaults.openvino.stateful),
      cache: bool(env.GEMMA_OPENVINO_CACHE ?? o.cache, defaults.openvino.cache),
      npuPrefillChunk: num(env.GEMMA_OPENVINO_NPU_PREFILL_CHUNK ?? o.npu_prefill_chunk, defaults.openvino.npuPrefillChunk),
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
