import pkg from "../package.json" with { type: "json" };
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Backend, setBackend } from "./backend-config.ts";
import { type Config, loadConfig } from "./config.ts";
import { doctor } from "./doctor.ts";
import { LlamaServer } from "./llama.ts";
import { configureLogger, log } from "./log.ts";
import { paths } from "./paths.ts";
import { registerTools } from "./tools.ts";

/** The version lives in package.json only; the bundler inlines it here. */
const VERSION: string = pkg.version;

function usage(): string {
  return [
    `gemma-mcp ${VERSION} -- serve a local Gemma model over MCP`,
    "",
    "Usage:",
    "  gemma-mcp                 Serve MCP over stdio (default)",
    "  gemma-mcp doctor          Diagnose GPU, runtime, model and config",
    "  gemma-mcp serve           Start llama-server only and stay resident",
    "  gemma-mcp print-config    Print MCP client configuration as JSON",
    "  gemma-mcp set-backend <b> Select the runtime: cuda (NVIDIA) or openvino (Intel)",
    "  gemma-mcp --version       Print the version",
    "",
    "Options:",
    "  --config <path>           Config file (default: config/gemma.toml)",
    "",
    `Application root: ${paths.root}`,
  ].join("\n");
}

function printClientConfig(): void {
  // During development the process runs under an interpreter; a built executable runs alone.
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

function buildServer(llama: LlamaServer, config: Config) {
  const server = new McpServer(
    { name: "gemma", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Runs Gemma 4 locally through llama.cpp. Calls are free and nothing leaves the machine, " +
        "so this is a good place to offload summarising, classification, extraction and drafting, " +
        "especially in bulk or on sensitive material. The first call may be slow while the model loads.",
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
  if (command === "set-backend") {
    const requested = positional[1];
    if (requested !== "cuda" && requested !== "openvino") {
      process.stderr.write(`Usage: gemma-mcp set-backend <cuda|openvino>\n`);
      process.exitCode = 2;
      return;
    }
    const change = setBackend(requested as Backend);
    process.stdout.write(
      `backend = "${change.backend}" in ${change.configFile}${change.created ? " (created)" : ""}\n`,
    );
    if (change.modelHf) {
      process.stdout.write(`model.hf = "${change.modelHf}" (default for this backend)\n`);
    }
    return;
  }
  if (command === "doctor") {
    process.exitCode = await doctor(config);
    return;
  }

  const llama = new LlamaServer(config);

  if (command === "serve") {
    log.info("Starting llama-server only; not listening for MCP");
    await llama.ensureReady();
    process.stdout.write(`llama-server ready: ${llama.endpoint}\n`);
    await new Promise(() => undefined); // stay resident until Ctrl+C
    return;
  }
  if (command !== "") {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  // Default: act as an MCP server. From here on stdout is JSON-RPC only.
  log.info("Starting MCP server", { root: paths.root, endpoint: llama.endpoint });

  serveStdio(() => buildServer(llama, config), {
    onerror: (error) => log.error("MCP transport error", error),
  });
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exitCode = 1;
});
