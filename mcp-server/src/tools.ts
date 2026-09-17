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

/** Sampling controls shared by every generating tool. */
const samplingFields = {
  temperature: z.number().min(0).max(2).optional().describe("Lower is more deterministic; defaults to the configured value"),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).optional(),
  max_tokens: z.number().int().min(1).max(131072).optional().describe("Maximum number of tokens to generate"),
  stop: z.array(z.string()).max(8).optional().describe("Stop generation when one of these strings appears"),
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

/** Progress reporter; a no-op unless the client sent a progress token. */
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
          message: `Generating... ${accumulated.length} characters`,
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
    notes.push("(truncated: hit max_tokens)");
  }
  const text = notes.length > 0 ? `${result.text}\n\n${notes.join(" ")}` : result.text;
  return {
    content: [{ type: "text" as const, text: text === "" ? "(empty response)" : text }],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof LlamaError
      ? error.message
      : error instanceof Error && error.name === "AbortError"
        ? "Generation was cancelled or timed out."
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
  log.error("Tool call failed", message);
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
      title: "Ask Gemma",
      description:
        "Send a single prompt to the local Gemma model and get the answer back. " +
        "Costs nothing per call and never leaves this machine, which makes it a good fit for " +
        "summarising, drafting, classifying and other bulk or privacy-sensitive work. Stateless.",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("The instruction or question for Gemma"),
        system: z.string().optional().describe("System prompt: role, tone, output format"),
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
      title: "Continue a conversation with Gemma",
      description:
        "Continue a multi-turn conversation. The server keeps no state, so pass the full " +
        "history in `messages` on every call.",
      inputSchema: z.object({
        messages: z.array(messageSchema).min(1).describe("Conversation history, oldest first"),
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
      title: "Get structured output from Gemma",
      description:
        "Generate JSON that conforms to the supplied JSON Schema. llama.cpp constrains decoding " +
        "with a grammar, so output outside the schema cannot be produced. Use this for extraction, " +
        "classification and normalisation.",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("What to extract or classify"),
        schema: z
          .record(z.string(), z.unknown())
          .describe('JSON Schema for the result, e.g. {"type":"object","properties":{...}}'),
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
      title: "Ask Gemma about an image",
      description:
        "Ask a question about an image. Provide either `image_path` (a local file) or " +
        "`image_base64`. Requires a multimodal projector (mmproj) to be loaded.",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("The question or instruction about the image"),
        image_path: z.string().optional().describe("Absolute path to a local image file"),
        image_base64: z.string().optional().describe("Base64-encoded image data"),
        mime_type: z.string().optional().describe("MIME type to use with image_base64"),
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
          dataUrl = args.image_base64.startsWith("data:")
            ? args.image_base64
            : `data:${mime};base64,${args.image_base64}`;
        } else {
          return {
            content: [{ type: "text" as const, text: "Either image_path or image_base64 is required." }],
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
    running: z.boolean().describe("Whether llama-server is answering"),
    managed: z.boolean().describe("Whether this MCP server started that process"),
    endpoint: z.string(),
    model: z.string().nullable(),
    context_size: z.number().nullable(),
    configured_model: z.string().describe("Configured model: local path or Hugging Face spec"),
    autostart: z.boolean(),
  });

  server.registerTool(
    "gemma_status",
    {
      title: "Check Gemma's status",
      description:
        "Report whether llama-server is running, which model is loaded and how large the context is. " +
        "Use it to diagnose failing generations.",
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
