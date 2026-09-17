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

beforeAll(async () => {
  mock = startMockLlama();
  home = mkdtempSync(join(tmpdir(), "gemma-mcp-test-"));

  client = new StdioClient(["bun", "run", entry], {
    GEMMA_HOME: home,
    GEMMA_PORT: String(mock.port),
    GEMMA_HOST: "127.0.0.1",
    // llama-server の実体は無いので自動起動は止め、モックだけを見る
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
  test("5 つのツールを公開する", async () => {
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
  test("モックの応答をそのまま返す", async () => {
    mock.reply = "テスト応答";
    const result = await callTool("gemma_ask", { prompt: "こんにちは" });

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("テスト応答");
  });

  test("system と max_tokens がリクエストに反映される", async () => {
    await callTool("gemma_ask", { prompt: "要約して", system: "あなたは要約器です", max_tokens: 64 });

    const last = mock.requests.filter((entry) => entry.path === "/v1/chat/completions").at(-1);
    const body = last?.body as { messages: { role: string; content: string }[]; max_tokens: number };

    expect(body.messages[0]).toEqual({ role: "system", content: "あなたは要約器です" });
    expect(body.messages[1]).toEqual({ role: "user", content: "要約して" });
    expect(body.max_tokens).toBe(64);
  });

  test("progressToken があるとストリーミングして進捗を通知する", async () => {
    mock.reply = "進捗テスト";
    const before = client.notifications.length;

    const result = await callTool("gemma_ask", { prompt: "数えて" }, { progressToken: "tok-1" });
    expect(firstText(result)).toContain("進捗テスト");

    const last = mock.requests.filter((entry) => entry.path === "/v1/chat/completions").at(-1);
    expect((last?.body as { stream: boolean }).stream).toBe(true);

    const progress = client.notifications
      .slice(before)
      .filter((notification) => notification.method === "notifications/progress");
    expect(progress.length).toBeGreaterThan(0);
    expect((progress[0]?.params as { progressToken: string }).progressToken).toBe("tok-1");
  });
});

describe("gemma_chat", () => {
  test("会話履歴をそのまま渡す", async () => {
    await callTool("gemma_chat", {
      messages: [
        { role: "user", content: "1 足す 1 は?" },
        { role: "assistant", content: "2 です" },
        { role: "user", content: "では 2 足す 2 は?" },
      ],
    });

    const last = mock.requests.filter((entry) => entry.path === "/v1/chat/completions").at(-1);
    const body = last?.body as { messages: unknown[] };
    expect(body.messages).toHaveLength(3);
  });

  test("空の messages はスキーマで弾かれる", async () => {
    const result = await callTool("gemma_chat", { messages: [] });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("validation error");
  });
});

describe("gemma_json", () => {
  test("response_format に JSON Schema を渡す", async () => {
    mock.reply = '{"sentiment":"positive"}';
    const schema = {
      type: "object",
      properties: { sentiment: { type: "string" } },
      required: ["sentiment"],
    };

    const result = await callTool("gemma_json", { prompt: "感情を判定して: 最高だ", schema });
    expect(firstText(result)).toContain("positive");

    const last = mock.requests.filter((entry) => entry.path === "/v1/chat/completions").at(-1);
    const body = last?.body as {
      response_format: { type: string; json_schema: { schema: unknown; strict: boolean } };
      temperature: number;
    };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema).toEqual(schema);
    expect(body.temperature).toBe(0);
  });
});

describe("gemma_vision", () => {
  test("base64 画像を data URL にして送る", async () => {
    mock.reply = "赤い四角が写っています";
    const result = await callTool("gemma_vision", {
      prompt: "何が写っている?",
      image_base64: "iVBORw0KGgo=",
      mime_type: "image/png",
    });

    expect(result.isError).toBeFalsy();
    const last = mock.requests.filter((entry) => entry.path === "/v1/chat/completions").at(-1);
    const body = last?.body as { messages: { content: { type: string; image_url?: { url: string } }[] }[] };
    const parts = body.messages[0]?.content ?? [];
    expect(parts[0]?.type).toBe("image_url");
    expect(parts[0]?.image_url?.url).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("画像が無い場合はエラーを返す", async () => {
    const result = await callTool("gemma_vision", { prompt: "何が写っている?" });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("image_path");
  });
});

describe("gemma_status", () => {
  test("構造化された状態を返す", async () => {
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

describe("stdout の衛生", () => {
  test("JSON-RPC 以外が stdout に出力されない", () => {
    const strays = client.stderr.filter((line) => line.includes("stdout に JSON 以外が出力されました"));
    expect(strays).toHaveLength(0);
  });
});
