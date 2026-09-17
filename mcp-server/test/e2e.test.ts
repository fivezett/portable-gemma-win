import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { type MockLlama, startMockLlama } from "./mock-llama.ts";
import { StdioClient } from "./stdio-client.ts";

let mock: MockLlama;
let client: StdioClient;
let home: string;

const entry = join(import.meta.dir, "..", "src", "index.ts");

/**
 * By default the suite runs the TypeScript sources. Setting GEMMA_MCP_BIN points it at a
 * compiled executable instead, so CI can exercise the artifact it is about to ship.
 * Bundling changes module evaluation order, and only running the real binary catches that.
 */
const command = process.env.GEMMA_MCP_BIN ? [process.env.GEMMA_MCP_BIN] : ["bun", "run", entry];

type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  result?: Record<string, unknown>;
};

async function callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const result = await client.request("tools/call", {
    name,
    arguments: args,
    ...(meta ? { _meta: meta } : {}),
  });
  return result as ToolResult;
}

function firstText(result: ToolResult): string {
  return result.content?.find((part) => part.type === "text")?.text ?? "";
}

function lastCompletionBody<T>(): T {
  const entry = mock.requests.filter((request) => request.path === "/v1/chat/completions").at(-1);
  return entry?.body as T;
}

beforeAll(async () => {
  mock = startMockLlama();
  home = mkdtempSync(join(tmpdir(), "gemma-mcp-test-"));

  client = new StdioClient(command, {
    GEMMA_HOME: home,
    GEMMA_PORT: String(mock.port),
    GEMMA_HOST: "127.0.0.1",
    // There is no real llama-server here, so never try to spawn one: talk to the mock.
    GEMMA_AUTOSTART: "0",
    GEMMA_LOG_LEVEL: "error",
    GEMMA_MAX_TOKENS: "256",
  });

  const initialize = await client.request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  });
  expect(initialize.serverInfo).toMatchObject({ name: "gemma" });
  client.notify("notifications/initialized");
});

afterAll(async () => {
  await client?.close();
  mock?.stop();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("MCP surface", () => {
  test("exposes exactly the five tools", async () => {
    const result = await client.request("tools/list");
    const tools = (result.tools ?? []) as { name: string; inputSchema?: unknown }[];
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual(["gemma_ask", "gemma_chat", "gemma_json", "gemma_status", "gemma_vision"]);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

describe("gemma_ask", () => {
  test("returns what the model produced", async () => {
    mock.reply = "test response";
    const result = await callTool("gemma_ask", { prompt: "hello" });

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("test response");
  });

  test("forwards system prompt and max_tokens", async () => {
    await callTool("gemma_ask", { prompt: "summarise this", system: "You are a summariser", max_tokens: 64 });

    const body = lastCompletionBody<{ messages: { role: string; content: string }[]; max_tokens: number }>();
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a summariser" });
    expect(body.messages[1]).toEqual({ role: "user", content: "summarise this" });
    expect(body.max_tokens).toBe(64);
  });

  test("streams and reports progress when given a progress token", async () => {
    mock.reply = "progress test";
    const before = client.notifications.length;

    const result = await callTool("gemma_ask", { prompt: "count" }, { progressToken: "tok-1" });
    expect(firstText(result)).toContain("progress test");

    expect(lastCompletionBody<{ stream: boolean }>().stream).toBe(true);

    const progress = client.notifications
      .slice(before)
      .filter((notification) => notification.method === "notifications/progress");
    expect(progress.length).toBeGreaterThan(0);
    expect((progress[0]?.params as { progressToken: string }).progressToken).toBe("tok-1");
  });
});

describe("gemma_chat", () => {
  test("passes the conversation history through unchanged", async () => {
    await callTool("gemma_chat", {
      messages: [
        { role: "user", content: "what is 1 + 1?" },
        { role: "assistant", content: "2" },
        { role: "user", content: "and 2 + 2?" },
      ],
    });

    expect(lastCompletionBody<{ messages: unknown[] }>().messages).toHaveLength(3);
  });

  test("rejects an empty message list through the schema", async () => {
    const result = await callTool("gemma_chat", { messages: [] });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("validation error");
  });
});

describe("gemma_json", () => {
  test("constrains decoding with the supplied JSON Schema", async () => {
    mock.reply = '{"sentiment":"positive"}';
    const schema = {
      type: "object",
      properties: { sentiment: { type: "string" } },
      required: ["sentiment"],
    };

    const result = await callTool("gemma_json", { prompt: "classify: this is great", schema });
    expect(firstText(result)).toContain("positive");

    const body = lastCompletionBody<{
      response_format: { type: string; json_schema: { schema: unknown; strict: boolean } };
      temperature: number;
    }>();
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema).toEqual(schema);
    expect(body.temperature).toBe(0);
  });
});

describe("gemma_vision", () => {
  test("wraps base64 image data in a data URL", async () => {
    mock.reply = "a red square";
    const result = await callTool("gemma_vision", {
      prompt: "what is in this image?",
      image_base64: "iVBORw0KGgo=",
      mime_type: "image/png",
    });

    expect(result.isError).toBeFalsy();
    const body = lastCompletionBody<{
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    }>();
    const parts = body.messages[0]?.content ?? [];
    expect(parts[0]?.type).toBe("image_url");
    expect(parts[0]?.image_url?.url).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("errors when no image is supplied", async () => {
    const result = await callTool("gemma_vision", { prompt: "what is in this image?" });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("image_path");
  });
});

describe("gemma_status", () => {
  test("returns structured status", async () => {
    const result = await callTool("gemma_status", {});
    const structured = (result.structuredContent ?? result.result) as Record<string, unknown> | undefined;

    expect(structured).toBeDefined();
    expect(structured?.running).toBe(true);
    expect(structured?.managed).toBe(false);
    expect(structured?.endpoint).toBe(`http://127.0.0.1:${mock.port}`);
    expect(structured?.context_size).toBe(4096);
    expect(structured?.autostart).toBe(false);
  });
});

describe("stdout hygiene", () => {
  test("nothing but JSON-RPC reaches stdout", () => {
    const strays = client.stderr.filter((line) => line.includes("non-JSON output on stdout"));
    expect(strays).toHaveLength(0);
  });
});
