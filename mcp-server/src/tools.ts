import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Config } from "./config.ts";
import {
  type ChatMessage,
  type CompletionResult,
  type ContentPart,
  LlamaError,
  type LlamaServer,
} from "./llama.ts";
import { log } from "./log.ts";

/** 生成系ツールで共通のサンプリング指定 */
const samplingFields = {
  temperature: z.number().min(0).max(2).optional().describe("低いほど決定的。既定は設定ファイルの値"),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).optional(),
  max_tokens: z.number().int().min(1).max(131072).optional().describe("生成する最大トークン数"),
  stop: z.array(z.string()).max(8).optional().describe("この文字列が現れたら生成を打ち切る"),
};

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

type SamplingArgs = {
  temperature?: number | undefined;
  top_p?: number | undefined;
  top_k?: number | undefined;
  max_tokens?: number | undefined;
  stop?: string[] | undefined;
};

/** 進捗通知。progressToken が来ていないときは何もしない */
function progressReporter(ctx: ServerContext): ((accumulated: string, delta: string) => void) | undefined {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined || token === null) return undefined;

  let lastSent = 0;
  return (accumulated: string) => {
    const now = Date.now();
    if (now - lastSent < 1000) return;
    lastSent = now;
    void ctx.mcpReq
      .notify({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: accumulated.length,
          message: `生成中… ${accumulated.length} 文字`,
        },
      })
      .catch(() => undefined);
  };
}

function toSamplingOptions(args: SamplingArgs) {
  return {
    temperature: args.temperature,
    topP: args.top_p,
    topK: args.top_k,
    maxTokens: args.max_tokens,
    stop: args.stop,
  };
}

function textResult(result: CompletionResult) {
  const notes: string[] = [];
  if (result.finishReason === "length") {
    notes.push("(max_tokens に達して打ち切られました)");
  }
  const text = notes.length > 0 ? `${result.text}\n\n${notes.join(" ")}` : result.text;
  return {
    content: [{ type: "text" as const, text: text === "" ? "(空の応答)" : text }],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof LlamaError
      ? error.message
      : error instanceof Error && error.name === "AbortError"
        ? "生成がキャンセル、またはタイムアウトしました。"
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
  log.error("ツール実行に失敗しました", message);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

function guessMimeType(path: string): string {
  return mimeTypes[extname(path).toLowerCase()] ?? "image/png";
}

export function registerTools(server: McpServer, llama: LlamaServer, config: Config): void {
  server.registerTool(
    "gemma_ask",
    {
      title: "Gemma に質問する",
      description:
        "ローカルの Gemma に単発の質問を投げて回答を得る。要約・下書き・分類など、" +
        "外部に出したくない内容や、安価に大量処理したい内容に向く。会話は保持しない。",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("Gemma に渡す指示または質問"),
        system: z.string().optional().describe("システムプロンプト(役割や出力形式の指定)"),
        ...samplingFields,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        const messages: ChatMessage[] = [];
        if (args.system) messages.push({ role: "system", content: args.system });
        messages.push({ role: "user", content: args.prompt });

        const result = await llama.complete({
          messages,
          ...toSamplingOptions(args),
          signal: ctx.mcpReq.signal,
          onProgress: progressReporter(ctx),
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "gemma_chat",
    {
      title: "Gemma と多ターン対話する",
      description:
        "会話履歴をまとめて渡して続きを生成する。サーバー側は状態を持たないため、" +
        "呼び出し側が messages に全履歴を含めること。",
      inputSchema: z.object({
        messages: z.array(messageSchema).min(1).describe("古い順に並べた会話履歴"),
        ...samplingFields,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        const result = await llama.complete({
          messages: args.messages,
          ...toSamplingOptions(args),
          signal: ctx.mcpReq.signal,
          onProgress: progressReporter(ctx),
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "gemma_json",
    {
      title: "Gemma で構造化出力を得る",
      description:
        "JSON Schema を渡し、それに従う JSON だけを生成させる。抽出・分類・整形に使う。" +
        "llama.cpp 側で文法を強制するため、スキーマ外の出力は生成されない。",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("抽出や分類の指示"),
        schema: z
          .record(z.string(), z.unknown())
          .describe("出力を縛る JSON Schema (例: {\"type\":\"object\",\"properties\":{...}})"),
        system: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().min(1).max(131072).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        const messages: ChatMessage[] = [];
        if (args.system) messages.push({ role: "system", content: args.system });
        messages.push({ role: "user", content: args.prompt });

        const result = await llama.complete({
          messages,
          temperature: args.temperature ?? 0,
          maxTokens: args.max_tokens,
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "gemma_structured_output", schema: args.schema, strict: true },
          },
          signal: ctx.mcpReq.signal,
          onProgress: progressReporter(ctx),
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "gemma_vision",
    {
      title: "Gemma で画像を読む",
      description:
        "画像について Gemma に質問する。image_path(ローカルの画像ファイル)か " +
        "image_base64 のどちらかを指定する。mmproj が設定されている必要がある。",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("画像に対する質問や指示"),
        image_path: z.string().optional().describe("ローカル画像ファイルの絶対パス"),
        image_base64: z.string().optional().describe("base64 エンコードされた画像データ"),
        mime_type: z.string().optional().describe("image_base64 を使う場合の MIME タイプ"),
        ...samplingFields,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        let dataUrl: string;
        if (args.image_path) {
          const bytes = readFileSync(args.image_path);
          const mime = args.mime_type ?? guessMimeType(args.image_path);
          dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
        } else if (args.image_base64) {
          const mime = args.mime_type ?? "image/png";
          const payload = args.image_base64.startsWith("data:")
            ? args.image_base64
            : `data:${mime};base64,${args.image_base64}`;
          dataUrl = payload;
        } else {
          return {
            content: [{ type: "text" as const, text: "image_path か image_base64 のどちらかが必要です。" }],
            isError: true,
          };
        }

        const content: ContentPart[] = [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: args.prompt },
        ];

        const result = await llama.complete({
          messages: [{ role: "user", content }],
          ...toSamplingOptions(args),
          signal: ctx.mcpReq.signal,
          onProgress: progressReporter(ctx),
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const statusOutput = z.object({
    running: z.boolean().describe("llama-server が応答しているか"),
    managed: z.boolean().describe("この MCP サーバーが起動したプロセスか"),
    endpoint: z.string(),
    model: z.string().nullable(),
    context_size: z.number().nullable(),
    configured_model: z.string().describe("設定上のモデル指定 (ローカルパスまたは HF 指定)"),
    autostart: z.boolean(),
  });

  server.registerTool(
    "gemma_status",
    {
      title: "Gemma の状態を確認する",
      description:
        "llama-server が動いているか、どのモデルが読み込まれているか、コンテキスト長はいくつかを返す。" +
        "生成が失敗するときの切り分けに使う。",
      inputSchema: z.object({}),
      outputSchema: statusOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const running = await llama.health();
      const props = running ? await llama.props() : null;
      const structured = {
        running,
        managed: llama.managed,
        endpoint: llama.endpoint,
        model: props?.model ?? null,
        context_size: props?.contextSize ?? null,
        configured_model: config.model.path !== "" ? config.model.path : config.model.hf,
        autostart: config.server.autostart,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    },
  );
}
