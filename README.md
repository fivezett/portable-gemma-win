# portable-gemma-win

A portable **Gemma 4 + llama.cpp (CUDA)** setup for Windows that serves the local model
over **MCP**, so clients like Claude Code can call it as a tool.

- **Nothing to install**: no CUDA Toolkit, no Node.js. An NVIDIA graphics driver is enough.
- **Carry the folder**: executable, runtime, models and configuration all live in one directory.
- **No API bills, no data leaving the machine**: inference runs on the local GPU.

```
MCP client (Claude Code, ...)
        |  stdio / JSON-RPC
        v
   gemma-mcp.exe          single-file MCP server, built with Bun
        |  HTTP (127.0.0.1)
        v
   llama-server.exe       official llama.cpp Windows CUDA build
        |
        v
   Gemma 4 (GGUF)
```

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (x64) |
| GPU | NVIDIA. The CUDA 13 builds need **Turing (GTX 1600 / RTX 2000) or newer** |
| Driver | An NVIDIA graphics driver. **No CUDA Toolkit.** |
| VRAM | 8 GB runs Gemma 4 E4B at Q4. 12 GB or more opens up the 12B model |
| Disk | ~300 MB of runtime plus 3-8 GB of model weights |

CUDA 13 dropped Pascal and older, so on a GTX 10xx the setup script falls back to a
CUDA 12 build automatically.

## Setup

### With the installer

Run `portable-gemma-setup-<version>.exe`. It needs no administrator rights and installs
into `%LOCALAPPDATA%\PortableGemma` by default. The runtime and the model can be
downloaded from the installer as well.

### From the archive

```powershell
# 1. Extract anywhere, including a USB stick
# 2. Fetch the llama.cpp runtime
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-runtime.ps1

# 3. Fetch the model (optional; it downloads on the first tool call otherwise)
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-model.ps1

# 4. Check the environment
.\gemma-mcp.exe doctor
```

## Registering with an MCP client

```bash
claude mcp add gemma -- "C:\path\to\gemma-mcp.exe"
```

Or in a configuration file:

```json
{
  "mcpServers": {
    "gemma": {
      "command": "C:\\path\\to\\gemma-mcp.exe",
      "env": { "GEMMA_HOME": "C:\\path\\to\\PortableGemma" }
    }
  }
}
```

`gemma-mcp.exe print-config` prints that JSON for your machine. See [docs/MCP.md](docs/MCP.md)
for the details.

## Tools

| Tool | Purpose |
|---|---|
| `gemma_ask` | One-shot prompt: summaries, drafts, rewrites |
| `gemma_chat` | Continue a conversation from supplied history |
| `gemma_json` | Constrain output to a JSON Schema |
| `gemma_vision` | Ask about an image (needs mmproj) |
| `gemma_status` | Report the running model, context size and health |

## Layout

```
PortableGemma/
├── gemma-mcp.exe              the MCP server
├── mcp-config.json            client configuration (written by the installer)
├── config/gemma.toml          configuration
├── runtime/llama/             llama.cpp binaries and CUDA DLLs
├── models/                    GGUF files (LLAMA_CACHE)
├── logs/gemma-mcp.log         logs
├── scripts/                   download and launch scripts
└── docs/                      documentation
```

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — setup, model selection, troubleshooting
- [docs/MCP.md](docs/MCP.md) — client registration and the tool reference
- [docs/SPEC.md](docs/SPEC.md) — the design and why it looks like this
- [docs/RELEASE.md](docs/RELEASE.md) — CI/CD and how releases work

## Development

```bash
cd mcp-server
bun install
bun test          # integration tests over stdio against a mock llama-server
bun run check     # typecheck (TypeScript 7)

cd ..
bun run scripts/build.ts    # executable, portable archive and installer
```

To release, bump the version and push to `main`; tagging and publishing happen
automatically. See [docs/RELEASE.md](docs/RELEASE.md).

```bash
bun run scripts/release.ts 0.2.0
git push origin main
```

## Licence

The code in this repository is MIT.
llama.cpp (MIT) and Gemma 4 (Apache-2.0) keep their own licences.
