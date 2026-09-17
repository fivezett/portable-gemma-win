import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { baseUrl, type Config } from "./config.ts";
import { attachToKillOnExitJob } from "./jobobject.ts";
import { log } from "./log.ts";
import { paths } from "./paths.ts";

export class LlamaError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlamaError";
    this.status = status;
  }
}

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = TextPart | ImagePart;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

export type CompletionOptions = {
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: Record<string, unknown>;
  /** Abort signal; the MCP cancellation signal is passed straight through */
  signal?: AbortSignal;
  /** Incremental output callback; providing it switches to streaming */
  onProgress?: (accumulated: string, delta: string) => void;
};

export type CompletionResult = {
  text: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Tokens per second from llama-server timings, or null when unavailable */
  tokensPerSecond: number | null;
};

export type ServerProps = {
  model: string | null;
  contextSize: number | null;
  raw: Record<string, unknown>;
};

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Arguments for llama-server. Exported so the backend-specific shape can be tested
 * without spawning anything: a wrong flag here is invisible until inference is slow.
 */
export function buildServerArgs(config: Config): string[] {
  const { server, model, runtime, openvino } = config;
  const openvinoBackend = runtime.backend === "openvino";

  // llama-server only serves one chat session when OpenVINO runs stateful.
  const parallel = openvinoBackend && openvino.stateful ? 1 : server.parallel;

  const args = [
    "--host",
    server.host,
    "--port",
    String(server.port),
    "--alias",
    model.alias,
    "-c",
    String(runtime.ctx),
    "-np",
    String(parallel),
    "-fa",
    runtime.flashAttn,
    // Chat template support, required for structured output and tool calls
    "--jinja",
  ];

  if (openvinoBackend) {
    // The OpenVINO backend places the whole graph on its device, so -ngl means nothing.
    // Warmup only pays for a graph compile whose result is thrown away.
    args.push("--no-warmup");
  } else {
    args.push("-ngl", String(runtime.ngl));
  }

  if (model.path !== "") args.push("-m", model.path);
  else args.push("-hf", model.hf);

  if (model.mmproj !== "") args.push("--mmproj", model.mmproj);
  if (!server.webui) args.push("--no-webui");
  if (server.apiKey !== "") args.push("--api-key", server.apiKey);

  args.push(...runtime.extraArgs);
  return args;
}

/**
 * Environment for the child process, including the OpenVINO backend controls.
 * Getting one of these variables wrong means silently running on the wrong device.
 */
export function buildServerEnv(config: Config, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    // Pin GGUF storage inside the app folder so the whole thing stays portable
    LLAMA_CACHE: paths.modelsDir,
  };

  if (config.runtime.backend !== "openvino") return env;

  const { openvino, runtime } = config;
  const device = openvino.device;
  const isNpu = device.startsWith("NPU");

  env.GGML_OPENVINO_DEVICE = device;
  env.GGML_OPENVINO_STATEFUL_EXECUTION = openvino.stateful ? "1" : "0";

  if (openvino.cache && !isNpu) {
    // Caching is not supported on NPU; elsewhere it turns a minutes-long graph
    // compile into a blob load on every later start.
    env.GGML_OPENVINO_CACHE_DIR = paths.openvinoCacheDir;
    env.GGML_OPENVINO_COMPILED_MODEL_CACHE_DIR = paths.openvinoCacheDir;
  }

  if (isNpu) {
    env.GGML_OPENVINO_PREFILL_CHUNK_SIZE = String(openvino.npuPrefillChunk);
    if (runtime.ctx > 4096) {
      log.warn(
        `OpenVINO NPU with ctx=${runtime.ctx}: the NPU usually runs out of memory above a few ` +
          "thousand tokens. Lower runtime.ctx (1024-2048) if the server fails to start.",
      );
    }
  }

  return env;
}

export class LlamaServer {
  private readonly config: Config;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  /** Whether we started this llama-server; externally started ones are left alone */
  private ownsProcess = false;
  private exitHandlersInstalled = false;

  constructor(config: Config) {
    this.config = config;
  }

  get endpoint(): string {
    return baseUrl(this.config);
  }

  /** Which llama.cpp build this instance drives. */
  get backend(): Config["runtime"]["backend"] {
    return this.config.runtime.backend;
  }

  /** Exposed through gemma_status: did we start the process ourselves? */
  get managed(): boolean {
    return this.ownsProcess && this.child !== null;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.server.apiKey !== "") {
      headers.authorization = `Bearer ${this.config.server.apiKey}`;
    }
    return headers;
  }

  /** Poll /health; 200 means the model is loaded and ready */
  async health(timeoutMs = 2000): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async props(): Promise<ServerProps | null> {
    try {
      const response = await fetch(`${this.endpoint}/props`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const raw = asRecord(await response.json());
      if (!raw) return null;

      const defaultGeneration = asRecord(raw.default_generation_settings);
      return {
        model: typeof raw.model_path === "string" ? raw.model_path : null,
        contextSize: asNumber(defaultGeneration?.n_ctx) ?? asNumber(raw.n_ctx),
        raw,
      };
    } catch {
      return null;
    }
  }

  private installExitHandlers(): void {
    if (this.exitHandlersInstalled) return;
    this.exitHandlersInstalled = true;

    const stop = () => this.stopSync();
    process.on("exit", stop);
    process.on("SIGINT", () => {
      stop();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      stop();
      process.exit(143);
    });
  }

  private pipeOutput(child: ChildProcess): void {
    if (!this.config.log.llamaOutput) return;
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim() !== "") log.raw(line);
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
  }

  private async start(): Promise<void> {
    const { server, model } = this.config;

    if (!existsSync(server.binary)) {
      const hint =
        this.config.runtime.backend === "openvino"
          ? "Run scripts/fetch-runtime.ps1 -Backend openvino to download the OpenVINO runtime."
          : "Run scripts/fetch-runtime.ps1 to download the runtime.";
      throw new LlamaError(`llama-server not found at ${server.binary}\n${hint}`);
    }
    if (model.path !== "" && !existsSync(model.path)) {
      throw new LlamaError(`Configured GGUF not found: ${model.path}`);
    }

    mkdirSync(paths.modelsDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    if (this.config.runtime.backend === "openvino" && this.config.openvino.cache) {
      mkdirSync(paths.openvinoCacheDir, { recursive: true });
    }

    const args = buildServerArgs(this.config);
    log.info("Starting llama-server", { backend: this.config.runtime.backend, binary: server.binary, args });

    const child = spawn(server.binary, args, {
      cwd: paths.runtimeDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildServerEnv(this.config),
    });

    this.child = child;
    this.ownsProcess = true;
    this.ready = false;
    this.installExitHandlers();
    this.pipeOutput(child);

    if (typeof child.pid === "number") {
      const attached = attachToKillOnExitJob(child.pid);
      if (!attached) {
        log.debug("No job object available; falling back to exit-handler shutdown");
      }
    }

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      this.ready = false;
      this.child = null;
      this.ownsProcess = false;
      log.warn("llama-server exited", { code, signal });
    });
    child.once("error", (error) => {
      log.error("Failed to spawn llama-server", error);
    });

    const deadline = Date.now() + this.config.timeouts.startupMs;
    while (Date.now() < deadline) {
      if (exited) {
        const detail = exited as { code: number | null; signal: NodeJS.Signals | null };
        throw new LlamaError(
          `llama-server exited during startup (code=${detail.code} signal=${detail.signal}). ` +
            `See ${paths.logFile} for details.`,
        );
      }
      if (await this.health()) {
        this.ready = true;
        log.info("llama-server is ready", { endpoint: this.endpoint });
        return;
      }
      await Bun.sleep(500);
    }

    throw new LlamaError(
      `llama-server did not become ready within ${this.config.timeouts.startupMs} ms. ` +
        "The first run downloads the model, which takes a while. Either raise timeouts.startup_ms " +
        "or fetch the model up front with scripts/fetch-model.ps1.",
    );
  }

  /** Ensure the server can generate: reuse a running one, otherwise start it. */
  async ensureReady(): Promise<void> {
    if (this.ready && this.child !== null) return;
    if (await this.health()) {
      this.ready = true;
      // Something we did not spawn: started by hand, so not ours to stop.
      if (this.child === null) this.ownsProcess = false;
      return;
    }
    if (!this.config.server.autostart) {
      throw new LlamaError(
        `Nothing is answering at ${this.endpoint} and autostart is disabled.`,
      );
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private requestSignal(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeouts.requestMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  private buildBody(options: CompletionOptions, stream: boolean): Json {
    const { sampling, model } = this.config;
    const body: Json = {
      model: model.alias,
      messages: options.messages,
      temperature: options.temperature ?? sampling.temperature,
      top_p: options.topP ?? sampling.topP,
      top_k: options.topK ?? sampling.topK,
      max_tokens: options.maxTokens ?? sampling.maxTokens,
      stream,
    };
    if (options.stop && options.stop.length > 0) body.stop = options.stop;
    if (options.responseFormat) body.response_format = options.responseFormat;
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    await this.ensureReady();
    return options.onProgress ? this.completeStreaming(options) : this.completeOnce(options);
  }

  private async post(body: Json, signal: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LlamaError(
        `llama-server returned an error (HTTP ${response.status}): ${detail.slice(0, 500)}`,
        response.status,
      );
    }
    return response;
  }

  private async completeOnce(options: CompletionOptions): Promise<CompletionResult> {
    const response = await this.post(this.buildBody(options, false), this.requestSignal(options.signal));
    const payload = asRecord(await response.json());
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first?.message);
    const usage = asRecord(payload?.usage);
    const timings = asRecord(payload?.timings);

    return {
      text: typeof message?.content === "string" ? message.content : "",
      finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : null,
      promptTokens: asNumber(usage?.prompt_tokens),
      completionTokens: asNumber(usage?.completion_tokens),
      tokensPerSecond: asNumber(timings?.predicted_per_second),
    };
  }

  private async completeStreaming(options: CompletionOptions): Promise<CompletionResult> {
    const response = await this.post(this.buildBody(options, true), this.requestSignal(options.signal));
    const body = response.body;
    if (!body) throw new LlamaError("Streaming response had no body");

    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    let text = "";
    let finishReason: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let tokensPerSecond: number | null = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line; only "data:" lines matter.
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const event = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");

          for (const line of event.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "" || data === "[DONE]") continue;

            let chunk: Json | null;
            try {
              chunk = asRecord(JSON.parse(data));
            } catch {
              continue;
            }
            if (!chunk) continue;

            const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
            const first = asRecord(choices[0]);
            const delta = asRecord(first?.delta);
            const piece = typeof delta?.content === "string" ? delta.content : "";
            if (piece !== "") {
              text += piece;
              options.onProgress?.(text, piece);
            }
            if (typeof first?.finish_reason === "string") finishReason = first.finish_reason;

            const usage = asRecord(chunk.usage);
            if (usage) {
              promptTokens = asNumber(usage.prompt_tokens) ?? promptTokens;
              completionTokens = asNumber(usage.completion_tokens) ?? completionTokens;
            }
            const timings = asRecord(chunk.timings);
            if (timings) tokensPerSecond = asNumber(timings.predicted_per_second) ?? tokensPerSecond;
          }
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }

    return { text, finishReason, promptTokens, completionTokens, tokensPerSecond };
  }

  /** Synchronous stop for exit handlers; only touches a process we started. */
  stopSync(): void {
    const child = this.child;
    if (!child || !this.ownsProcess) return;
    this.child = null;
    this.ready = false;
    try {
      child.kill();
    } catch (error) {
      log.warn("Failed to stop llama-server", error);
    }
  }

  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    if (!child || !this.ownsProcess) return;
    this.stopSync();
    const deadline = Date.now() + graceMs;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}
