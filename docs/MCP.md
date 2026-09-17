# MCP client setup and tool reference

## Registering the server

`gemma-mcp.exe` speaks MCP over **stdio**: the client launches the process and talks
JSON-RPC across the pipes. Nothing has to be started or listening beforehand.

### Claude Code

```bash
claude mcp add gemma -- "C:\Users\<user>\AppData\Local\PortableGemma\gemma-mcp.exe"
```

### Configuration file

```json
{
  "mcpServers": {
    "gemma": {
      "command": "C:\\Users\\<user>\\AppData\\Local\\PortableGemma\\gemma-mcp.exe",
      "args": [],
      "env": {
        "GEMMA_HOME": "C:\\Users\\<user>\\AppData\\Local\\PortableGemma"
      }
    }
  }
}
```

`gemma-mcp.exe print-config` prints this for the current machine; the installer writes the
same content to `mcp-config.json`.

Other commands: `doctor` checks the environment, `set-backend <cuda|openvino>` selects the
runtime, and `serve` starts llama-server on its own.

`GEMMA_HOME` is optional. Without it, the folder containing the executable is used as the
application root, which is what you want unless the executable was copied elsewhere on its own.

### Running several configurations

The same executable can be registered more than once with different settings, for example
a heavier model with a longer context for slower, more considered work.

```json
{
  "mcpServers": {
    "gemma": {
      "command": "C:\\...\\gemma-mcp.exe"
    },
    "gemma-12b": {
      "command": "C:\\...\\gemma-mcp.exe",
      "env": {
        "GEMMA_MODEL_HF": "unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL",
        "GEMMA_PORT": "18081",
        "GEMMA_CTX": "8192"
      }
    }
  }
}
```

**Give each entry its own port.** Sharing one means the second server finds the first one's
llama-server already answering and talks to the wrong model.

## Lifecycle

- `llama-server` starts on the first tool call, not when the client starts, so registering
  the server does not tie up the GPU.
- If something is **already answering on the configured port, it is reused**. Two clients
  will not load the model twice and exhaust VRAM.
- Only a process this server started is ever stopped; anything started by hand is left alone.
- If the MCP client kills the server outright, a Windows Job Object still takes
  `llama-server` down with it. No orphan holding VRAM.

## Tools

### `gemma_ask`

A single prompt. Stateless.

| Argument | Type | Notes |
|---|---|---|
| `prompt` | string (required) | The instruction or question |
| `system` | string | System prompt |
| `temperature` / `top_p` / `top_k` | number | Sampling; defaults come from the config |
| `max_tokens` | number | Generation cap |
| `stop` | string[] | Up to 8 stop strings |

### `gemma_chat`

Continue a conversation. **The server holds no state**, so the caller passes the whole
history every time.

| Argument | Type | Notes |
|---|---|---|
| `messages` | `{role, content}[]` (required) | Oldest first; role is `system`, `user` or `assistant` |
| others | | Same as `gemma_ask` |

### `gemma_json`

Generate JSON that conforms to a schema. llama.cpp constrains decoding with a grammar, so
output outside the schema cannot be produced. `temperature` defaults to 0.

| Argument | Type | Notes |
|---|---|---|
| `prompt` | string (required) | What to extract or classify |
| `schema` | object (required) | JSON Schema |
| `system` | string | |
| `temperature` / `max_tokens` | number | |

```json
{
  "prompt": "Classify this review: boots fast but the battery drains quickly",
  "schema": {
    "type": "object",
    "properties": {
      "sentiment": { "type": "string", "enum": ["positive", "negative", "mixed"] },
      "topics": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["sentiment", "topics"]
  }
}
```

### `gemma_vision`

Ask about an image. Needs either `image_path` or `image_base64`, and a multimodal
projector (mmproj) has to be loaded.

Only available on the CUDA backend. With `backend = "openvino"` this returns an error
saying so, because multimodal support is still a work in progress upstream.

| Argument | Type | Notes |
|---|---|---|
| `prompt` | string (required) | The question about the image |
| `image_path` | string | Absolute path to a local image |
| `image_base64` | string | Base64 data |
| `mime_type` | string | MIME type for `image_base64` |

### `gemma_status`

Structured status, for working out why generation is failing.

Returns `running`, `managed`, `endpoint`, `backend` (`cuda` or `openvino`), `device`,
`model`, `context_size`, `configured_model` and `autostart`.

## Long generations

Local inference takes tens of seconds to minutes. When the client supplies
`_meta.progressToken`, `gemma-mcp` switches to streaming and emits
`notifications/progress` roughly once a second, counting characters generated so far.

If the client cancels the request, the `AbortSignal` propagates all the way to the HTTP
request against llama-server, so generation actually stops rather than running on unseen.

The per-request ceiling is `timeouts.request_ms` in `config\gemma.toml` (600 seconds by
default).

## What it is good for

From the perspective of a larger agent, `gemma` is a **free, unlimited subordinate that is
not as clever as you are**. That shapes what to send it:

- First-pass summarising, classification and tagging over lots of text
- Preprocessing material that should not leave the machine
- Cleaning up logs and error messages
- Routine work that is not worth an API call

It is a poor choice for deep reasoning or for generating large amounts of interdependent
code.
