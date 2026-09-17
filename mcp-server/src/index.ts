import pkg from "../package.json" with { type: "json" };
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, loadConfig } from "./config.ts";
import { doctor } from "./doctor.ts";
import { LlamaServer } from "./llama.ts";
import { configureLogger, log } from "./log.ts";
import { paths } from "./paths.ts";

/** バージョンの実体は package.json。バンドル時に埋め込まれる */
const VERSION: string = pkg.version;

function usage(): string {
  return [
    `gemma-mcp ${VERSION} — ローカル Gemma を MCP サーバーとして公開する`,
    "",
    "使い方:",
    "  gemma-mcp                 MCP サーバーとして stdio で待ち受ける(既定)",
    "  gemma-mcp doctor          環境診断(GPU / ランタイム / モデル / 設定)",
    "  gemma-mcp serve           llama-server だけを起動して常駐する",
    "  gemma-mcp print-config    MCP クライアント用の設定 JSON を表示する",
    "  gemma-mcp --version       バージョンを表示する",
    "",
    "オプション:",
    "  --config <path>           設定ファイル(既定: config/gemma.toml)",
    "",
    `アプリのルート: ${paths.root}`,
  ].join("\n");
}

function printClientConfig(): void {
  // 開発中 (bun run src/index.ts) はインタプリタ経由、配布時は exe 単体で起動する。
  const viaInterpreter = /(^|[\\/])bun(-debug)?(\.exe)?$/i.test(process.execPath);
  const snippet = {
    mcpServers: {
      gemma: {
        command: process.execPath,
        args: viaInterpreter ? ["run", Bun.main] : [],
        env: {
          GEMMA_HOME: paths.root,
        },
      },
    },
  };
  process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
}

function buildServer(llama: LlamaServer, config: Config, registerTools: typeof import("./tools.ts").registerTools) {
  const server = new McpServer(
    { name: "gemma", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "ローカルで動く Gemma 4 (llama.cpp) を提供する。API 課金がかからず、入力が外部に出ない。" +
        "要約・分類・抽出・下書きなど、大量処理や機密性の高い処理を任せるとよい。" +
        "初回の呼び出しはモデルの読み込みで時間がかかることがある。",
    },
  );
  registerTools(server, llama, config);
  return server;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const configIndex = argv.indexOf("--config");
  const configPath = configIndex !== -1 ? argv[configIndex + 1] : undefined;
  const positional = argv.filter((arg, index) => {
    if (arg === "--config") return false;
    if (configIndex !== -1 && index === configIndex + 1) return false;
    return true;
  });
  const command = positional[0] ?? "";

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const config = loadConfig(configPath);
  configureLogger(config.log.level);

  if (command === "print-config") {
    printClientConfig();
    return;
  }
  if (command === "doctor") {
    process.exitCode = await doctor(config);
    return;
  }

  const llama = new LlamaServer(config);

  if (command === "serve") {
    log.info("llama-server のみを起動します(MCP は待ち受けません)");
    await llama.ensureReady();
    process.stdout.write(`llama-server ready: ${llama.endpoint}\n`);
    await new Promise(() => undefined); // Ctrl+C まで常駐
    return;
  }
  if (command !== "") {
    process.stderr.write(`不明なコマンド: ${command}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  // 既定動作: MCP サーバー。以降 stdout は JSON-RPC 専用になる。
  const { registerTools } = await import("./tools.ts");
  log.info("MCP サーバーを開始します", { root: paths.root, endpoint: llama.endpoint });

  serveStdio(() => buildServer(llama, config, registerTools), {
    onerror: (error) => log.error("MCP トランスポートのエラー", error),
  });
}

main().catch((error) => {
  log.error("致命的なエラー", error);
  process.exitCode = 1;
});
