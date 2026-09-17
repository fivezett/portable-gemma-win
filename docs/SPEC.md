# Design notes

## Shape

```
MCP client --stdio/JSON-RPC-- gemma-mcp.exe --HTTP/127.0.0.1-- llama-server.exe -- GGUF
```

`gemma-mcp.exe` is a single executable built with Bun, so Node.js is never required.
Inference itself is left to the official `llama-server.exe`; this process only translates
between MCP and its HTTP API.

## Why llama-server does the inference

| Option | Verdict |
|---|---|
| **Spawn llama-server and talk HTTP** | Chosen |
| Run `llama-cli` per request | Rejected. Reloading the model on every call is a fixed cost of seconds even for E4B |
| `node-llama-cpp` in-process | Rejected. Embedding a native addon in `bun build --compile` is painful, and it means maintaining a second CUDA build |

The chosen option also brings:

- A KV cache that survives across calls
- The llama.cpp web UI, which makes manual checks easy
- Multimodal support (mmproj) as llama.cpp officially supports it
- Upgrades to llama.cpp by changing what the download script fetches

The HTTP client is Bun's built-in `fetch`; no OpenAI SDK. Parsing SSE takes about thirty
lines and is not worth a dependency.

## MCP SDK

`@modelcontextprotocol/server` v2 (spec 2026-07-28). `serveStdio()` also serves an
`initialize` from a 2025-era client (`legacy: 'serve'` is the default), so adopting the
newer spec costs no compatibility.

Schemas are zod v4. A single zod schema passed to `registerTool` produces the JSON Schema,
validates the arguments and types the handler.

### Why long generations do not use tasks

The original plan was to make long calls asynchronous with MCP v2 tasks (`tasks/get`,
`tasks/result`). Reading SDK 2.0.0 showed that:

- `registerTool` **discards** `execution` (where `taskSupport` would be declared)
- `McpServer` has **no task store and no `tasks/*` handlers** — only the schemas exist

Supporting tasks therefore means implementing that part of the protocol by hand, and client
support is unclear. Not worth it yet.

Instead, two things the SDK does fully support cover the practical problem:

- **Progress**: when the client sends `_meta.progressToken`, switch to streaming and emit
  `notifications/progress` once a second, so nothing looks hung.
- **Cancellation**: the handler's `AbortSignal` is passed straight into `fetch`, so
  cancelling the request stops generation on the llama-server side too.

If the SDK grows task support later, it can sit on top without changing the tools.

## Why it is stateless

Holding conversations server-side behind a `conversation_id` was considered and dropped.

- The MCP client already has the history; keeping a second copy invites drift
- A client restart or session switch orphans server-side state
- There is no good moment to expire it, which turns into a memory leak

Passing the full history to `gemma_chat` makes all of that structurally impossible. Most of
the recomputation cost is absorbed by llama.cpp's prefix cache.

## Orphan prevention (Windows Job Object)

When an MCP client kills `gemma-mcp.exe` with `TerminateProcess`, no JavaScript exit handler
runs, and `llama-server.exe` survives holding several GB of VRAM.

So the process calls into kernel32 through `bun:ffi` and puts the child in a Job Object
created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When the process dies the OS closes the
handle and the child goes with it. Nothing else survives a forced kill.

Where FFI is unavailable (non-Windows, or the DLL fails to load) it falls back to exit
handlers and logs a warning.

**Only processes this server started are stopped.** A llama-server launched by hand, or by
another instance, is never caught in the crossfire.

## Configuration format

TOML, because `Bun.TOML.parse` is built in — no dependency — and a commented template can
ship with the release. JSON has no comments and `.env` has no structure.

Precedence is `environment > TOML > defaults`. Being overridable from the MCP client's
`env` block is the point: one executable, several model configurations.

## Tool granularity

Five tools: `gemma_ask`, `gemma_chat`, `gemma_json`, `gemma_vision`, `gemma_status`.

There is deliberately no `gemma_summarize` or `gemma_translate`. The caller can write those
prompts itself, so task-shaped tools would clutter the tool list without adding capability.

## stdout discipline

On a stdio transport, **stdout carries JSON-RPC and nothing else**. A single stray line
breaks the protocol.

The logger therefore writes only to stderr and the log file, and llama-server's own output
is captured and relayed there too. The test suite asserts this: anything non-JSON on stdout
fails the run.

## Transport

stdio only. Streamable HTTP is supported by the SDK, but it drags in authentication, CORS
and port management for no benefit when everything is local. If reaching the model from
another machine ever matters, exposing `llama-server` itself is the simpler answer.

## Build and distribution

- **Cross-compilation**: `bun build --compile --target=bun-windows-x64` produces the
  executable from Linux, so CI and a developer machine make the same artifact
- **Building on Windows**: `--windows-icon` and `--windows-hide-console` only work there.
  Release executables are built on a Windows runner to get the hidden console
- **Both shapes**: a portable archive and an NSIS installer. The installer asks for no
  administrator rights and installs into `%LOCALAPPDATA%`, so it stays movable afterwards
- **No bundled model**: several GB, and redistribution is a headache. It is an installer
  option or a first-call download

## Testing

The suite starts a mock llama-server and **launches `gemma-mcp` as a real child process,
exchanging JSON-RPC over stdio**. It runs on Linux CI, so argument translation, progress
notifications, error handling and stdout hygiene are all covered without a Windows machine.

Setting `GEMMA_MCP_BIN` points the same suite at a compiled binary instead of the sources.
This is not optional polish: `bun build --compile` merges everything into one module graph
and changes evaluation order, which has already broken a dependency in a way that only
running the artifact could catch. CI runs the suite against the Windows executable, and
`scripts/build.ts` compiles a host-native binary to do the same thing locally.

What is still unverified without real hardware:

- CUDA builds actually running and offloading to the GPU
- Job Object teardown
- The PowerShell scripts and the NSIS installer end to end
