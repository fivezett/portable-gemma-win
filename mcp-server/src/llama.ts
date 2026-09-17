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
  /** 中断シグナル。MCP のキャンセル通知をそのまま渡す */
  signal?: AbortSignal;
  /** 生成の途中経過。渡すとストリーミングで受信する */
  onProgress?: (accumulated: string, delta: string) => void;
};

export type CompletionResult = {
  text: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** tok/s (llama-server の timings から算出。取得できなければ null) */
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

export class LlamaServer {
  private readonly config: Config;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  /** このプロセスが起動した llama-server かどうか。外部起動のものは停止しない */
  private ownsProcess = false;
  private exitHandlersInstalled = false;

  constructor(config: Config) {
    this.config = config;
  }

  get endpoint(): string {
    return baseUrl(this.config);
  }

  /** 自分が起動したプロセスかどうか(gemma_status 用) */
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

  /** /health を叩く。200 なら生成可能 */
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

  private buildArgs(): string[] {
    const { server, model, runtime } = this.config;
    const args = [
      "--host",
      server.host,
      "--port",
      String(server.port),
      "--alias",
      model.alias,
      "-c",
      String(runtime.ctx),
      "-ngl",
      String(runtime.ngl),
      "-np",
      String(server.parallel),
      "-fa",
      runtime.flashAttn,
      // ツール呼び出しや構造化出力のために chat template を有効化する
      "--jinja",
    ];

    if (model.path !== "") args.push("-m", model.path);
    else args.push("-hf", model.hf);

    if (model.mmproj !== "") args.push("--mmproj", model.mmproj);
    if (!server.webui) args.push("--no-webui");
    if (server.apiKey !== "") args.push("--api-key", server.apiKey);

    args.push(...runtime.extraArgs);
    return args;
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
      throw new LlamaError(
        `llama-server が見つかりません: ${server.binary}\n` +
          "scripts/fetch-runtime.ps1 を実行してランタイムを取得してください。",
      );
    }
    if (model.path !== "" && !existsSync(model.path)) {
      throw new LlamaError(`指定された GGUF が見つかりません: ${model.path}`);
    }

    mkdirSync(paths.modelsDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });

    const args = this.buildArgs();
    log.info("llama-server を起動します", { binary: server.binary, args });

    const child = spawn(server.binary, args, {
      cwd: paths.runtimeDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // GGUF の保存先をアプリ配下に固定し、フォルダごと持ち運べるようにする
        LLAMA_CACHE: paths.modelsDir,
      },
    });

    this.child = child;
    this.ownsProcess = true;
    this.ready = false;
    this.installExitHandlers();
    this.pipeOutput(child);

    if (typeof child.pid === "number") {
      const attached = attachToKillOnExitJob(child.pid);
      if (!attached) {
        log.debug("Job Object を使えないため、終了ハンドラでの停止のみになります");
      }
    }

    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      this.ready = false;
      this.child = null;
      this.ownsProcess = false;
      log.warn("llama-server が終了しました", { code, signal });
    });
    child.once("error", (error) => {
      log.error("llama-server の起動に失敗しました", error);
    });

    const deadline = Date.now() + this.config.timeouts.startupMs;
    while (Date.now() < deadline) {
      if (exited) {
        const detail = exited as { code: number | null; signal: NodeJS.Signals | null };
        throw new LlamaError(
          `llama-server が起動直後に終了しました (code=${detail.code} signal=${detail.signal})。` +
            `詳細は ${paths.logFile} を確認してください。`,
        );
      }
      if (await this.health()) {
        this.ready = true;
        log.info("llama-server の準備ができました", { endpoint: this.endpoint });
        return;
      }
      await Bun.sleep(500);
    }

    throw new LlamaError(
      `llama-server が ${this.config.timeouts.startupMs} ms 以内に応答しませんでした。` +
        "初回はモデルのダウンロードに時間がかかります。timeouts.startup_ms を延ばすか、" +
        "scripts/fetch-model.ps1 で先にモデルを取得してください。",
    );
  }

  /** 生成可能な状態を保証する。外部起動済みならそれを使い、無ければ自動起動する */
  async ensureReady(): Promise<void> {
    if (this.ready && this.child !== null) return;
    if (await this.health()) {
      this.ready = true;
      // 自分で起動していないプロセス = 手動起動。停止の責任は持たない。
      if (this.child === null) this.ownsProcess = false;
      return;
    }
    if (!this.config.server.autostart) {
      throw new LlamaError(
        `${this.endpoint} で llama-server が応答しません。autostart が無効なため自動起動しません。`,
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
        `llama-server がエラーを返しました (HTTP ${response.status}): ${detail.slice(0, 500)}`,
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
    if (!body) throw new LlamaError("ストリーミング応答の本文を取得できませんでした");

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

        // SSE は空行区切り。行頭 "data: " のみ処理する。
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

  /** 終了ハンドラから呼ぶ同期停止。自分が起動したプロセスだけ落とす */
  stopSync(): void {
    const child = this.child;
    if (!child || !this.ownsProcess) return;
    this.child = null;
    this.ready = false;
    try {
      child.kill();
    } catch (error) {
      log.warn("llama-server の停止に失敗しました", error);
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
