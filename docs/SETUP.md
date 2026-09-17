# Setup

## 1. GPU and runtime

The official llama.cpp releases ship Windows CUDA builds **with the CUDA runtime DLLs
included**, so there is no CUDA Toolkit to install. An NVIDIA graphics driver is enough.

`scripts\fetch-runtime.ps1` asks `nvidia-smi` for the GPU's compute capability and picks a
build from that.

| GPU generation | Compute capability | Build chosen |
|---|---|---|
| Blackwell (RTX 50xx) | 12.0 | `cuda-13.x` |
| Ada (RTX 40xx) | 8.9 | `cuda-13.x` |
| Ampere (RTX 30xx) | 8.6 | `cuda-13.x` |
| Turing (RTX 20xx / GTX 16xx) | 7.5 | `cuda-13.x` |
| Volta / Pascal / Maxwell | 7.0 and below | `cuda-12.x` |

CUDA 13 dropped Maxwell, Pascal and Volta, which is why a GTX 10xx needs a CUDA 12 build.
To be explicit about it:

```powershell
.\scripts\fetch-runtime.ps1 -Cuda 12 -Force
.\scripts\fetch-runtime.ps1 -Cuda 13.4 -Tag b11010   # pin an exact release
```

What was installed is recorded in `runtime\llama\runtime-version.json`.

### Intel hardware

On a machine without an NVIDIA GPU, use the OpenVINO build instead. It runs the same GGUF
models on Intel CPUs, integrated and Arc GPUs, and NPUs.

```powershell
.\scripts\fetch-runtime.ps1 -Backend openvino
```

Then set `backend = "openvino"` under `[runtime]` in `config\gemma.toml`. The two runtimes
live in different folders and can be installed side by side. Details, device selection and
the backend's limitations are in [OPENVINO.md](OPENVINO.md).

## 2. Choosing a model

Gemma 4 comes as E2B, E4B, 12B, 26B-A4B (mixture of experts) and 31B. Rough figures for
running a quantised GGUF on the GPU:

| Model | Memory at Q4 | Recommended VRAM | Context |
|---|---|---|---|
| E2B | ~3 GB | 4 GB+ | 128K |
| **E4B (default)** | ~5 GB | **8 GB+** | 128K |
| 12B | ~8 GB | 12-16 GB | 256K |
| 26B-A4B (MoE) | ~18 GB | 24 GB+ | 256K |
| 31B | ~20 GB | 24 GB+ | 256K |

**The KV cache costs VRAM on top of the weights**, and it grows with the context length.
Asking for 128K of context on an 8 GB card will not end well. The default `ctx = 16384`
is chosen to keep E4B comfortable on 8 GB.

Switch models by editing `[model] hf` in `config\gemma.toml`:

```toml
[model]
hf = "unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL"

[runtime]
ctx = 8192    # shorter context to fit 12B on a 12 GB card
```

QAT (quantisation aware training) builds degrade less than ordinary quantisation at the
same bit width, which makes them a good default here.

### Where models are stored

`LLAMA_CACHE` points at `models\`, so everything fetched with `-hf` lands inside the
application folder. **Copying the folder to another machine carries the models with it.**

For an offline machine, run `fetch-model.ps1` somewhere with a network first, then copy
the whole folder across.

A local `.gguf` works too:

```toml
[model]
path = "D:\\models\\gemma-4-E4B-it-Q4_K_M.gguf"
```

### Gated repositories

Set `HF_TOKEN` when the Hugging Face repository requires accepting a licence.

## 3. Configuration

Edit `config\gemma.toml`. Values resolve in this order:

```
environment variables from the MCP client > OS environment > config\gemma.toml > defaults
```

Every setting has a `GEMMA_`-prefixed environment variable (`GEMMA_PORT`, `GEMMA_MODEL_HF`,
`GEMMA_CTX`, `GEMMA_NGL`, `GEMMA_MAX_TOKENS`, ...). Because MCP clients can set those per
server entry, one executable can serve several different configurations.

The settings worth revisiting:

| Setting | Meaning | When to change it |
|---|---|---|
| `runtime.backend` | `cuda` or `openvino` | Pick the one matching the hardware |
| `runtime.ctx` | Context length | Lower it when VRAM runs short; 1024-2048 on an NPU |
| `runtime.ngl` | Layers on the GPU | 99 means all; lower it to spill onto the CPU |
| `sampling.max_tokens` | Per-call generation cap | Raise it if long answers get cut off |
| `timeouts.startup_ms` | Startup budget | Raise it if the first download does not finish in time |
| `server.parallel` | Parallel slots | Costs VRAM; keep at 1 on 8 GB |

## 4. Checking it works

```powershell
.\gemma-mcp.exe doctor
```

This reports the GPU, the runtime, the CUDA DLLs, the model, llama-server's health and the
configuration file in one pass.

To poke at the model directly:

```powershell
.\scripts\start-llama-server.cmd
# then open http://127.0.0.1:18080
```

## Troubleshooting

### "llama-server not found"

`scripts\fetch-runtime.ps1` has not been run. If it fails, the GitHub API rate limit
(60 requests an hour unauthenticated) is the usual cause; set `GITHUB_TOKEN` and retry.

### It runs, but very slowly

Nothing is on the GPU. Check that `doctor` finds the CUDA runtime DLLs, and look for CUDA
device lines in `logs\gemma-mcp.log`. If the DLLs are missing, re-run
`fetch-runtime.ps1 -Force`.

### Out of memory

In order:

1. Lower `runtime.ctx` (16384 -> 8192 -> 4096)
2. Move to a smaller model (12B -> E4B -> E2B)
3. Lower `runtime.ngl` to keep some layers on the CPU (99 -> 24, say)

### The first tool call times out

The model download did not fit inside `timeouts.startup_ms`. Either download it up front
with `fetch-model.ps1` or raise the timeout.

### llama-server keeps running

Normally the Job Object takes llama-server down with `gemma-mcp.exe`. If one survives:

```powershell
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process
```

A llama-server started by hand (through `scripts\start-llama-server.cmd`, for instance) is
**deliberately** outside that lifecycle and is never killed.

### Logs

`logs\gemma-mcp.log` holds output from both the MCP server and llama-server. For more
detail, set `[log] level = "debug"` in `config\gemma.toml`.
