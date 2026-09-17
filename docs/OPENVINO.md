# OpenVINO backend (Intel CPU / GPU / NPU)

The CUDA path covers NVIDIA cards. On Intel hardware — a Core Ultra laptop, an Arc card, or
a machine with no discrete GPU at all — the OpenVINO backend runs the same GGUF models on
the CPU, the integrated or discrete GPU, or the NPU.

## Why this project builds it

llama.cpp ships no prebuilt Windows binaries for the OpenVINO backend. The upstream
OpenVINO releases cover Ubuntu only, and enabling the backend requires compiling with
`-DGGML_OPENVINO=ON` plus Visual Studio Build Tools, the OpenVINO runtime and OpenCL.

So this repository builds it in CI and attaches the result to its releases. The pinned
versions live in `openvino/build-config.json`, and the build follows upstream's own
`build-openvino.yml`.

## Installing

The installer offers this as a choice on its components page, and preselects it on a
machine without an NVIDIA driver. From an extracted archive, or to add it to an existing
install:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-runtime.ps1 -Backend openvino
.\gemma-mcp.exe set-backend openvino
```

The download lands in `runtime\llama-openvino\`, leaving any CUDA runtime alone — both
backends can sit side by side, and `set-backend` switches between them. It also moves
`model.hf` to the quantisation this backend was validated against, unless you picked a
model yourself.

Pick the device in `config\gemma.toml`:

```toml
[openvino]
device = "GPU"   # CPU / GPU / NPU
```

Check it:

```powershell
.\gemma-mcp.exe doctor
```

## Choosing a device

| Device | When to use it |
|---|---|
| `CPU` | Always available. The default, and the fallback when anything else misbehaves |
| `GPU` | Intel integrated or Arc graphics. Usually the fastest option on a Core Ultra part |
| `NPU` | Long battery life and low power draw, at a small context size |

With more than one GPU, address a specific one as `GPU.0` or `GPU.1`.

## Models

Upstream validated the backend against `Q4_K_M` quantisations. For Gemma 4 the validated
builds are the `bartowski` ones:

```toml
[model]
hf = "bartowski/google_gemma-4-E4B-it-GGUF:Q4_K_M"
```

`set-backend openvino` selects that automatically.

What upstream reports for Gemma 4, all at `Q4_K_M`:

| Model | CPU | GPU | NPU |
|---|---|---|---|
| gemma-4-E2B-it | works | works | **fails** |
| gemma-4-E4B-it | works | works | works |
| gemma-4-12B-it | works | works | works |

The CUDA default (`unsloth/...:UD-Q4_K_XL`) is not one of the validated combinations. It may
well run — `Q5_K` and `Q6_K` tensors are requantised at load time — but `Q4_K_M` is the
supported path here.

## Limitations

These are properties of the backend, not of this project.

- **Stateful execution fails on Gemma 4.** `stateful = false` is the default for that
  reason. Leaving it off also avoids llama-server's single-chat-session restriction, which
  only applies in stateful mode.
- **No image input.** Multimodal support is a work in progress upstream, so `gemma_vision`
  returns an error explaining that rather than failing obscurely. Text tools are unaffected.
- **The NPU needs a small context.** Upstream recommends about 1024 tokens; the default
  resolves to the model's training context and can run out of memory. Set
  `runtime.ctx = 1024` (or 2048) when using the NPU. `doctor` flags a context that is too
  large for it.
- **Caching does not work on NPU.** It is skipped automatically there.
- **`ngl` does not apply.** The whole graph goes to the OpenVINO device, so the layer count
  is not passed through.

## Performance notes

The first run against a new model compiles the graph, which takes a while. With
`cache = true` (the default, and not available on NPU) that compiled model is written to
`cache\openvino\` and loaded directly afterwards. The cache lives inside the application
folder, so it travels with the rest of it.

## Rebuilding the runtime

To move to a newer llama.cpp or OpenVINO, edit `openvino/build-config.json` and run the
`openvino-runtime` workflow (it is also called automatically by every release):

```json
{
  "llamacpp_tag": "b11010",
  "openvino_version_major": "2026.3.1",
  "openvino_version_full": "2026.3.1.22476.56d9685302d"
}
```

The build takes tens of minutes, which is why it is not part of the ordinary CI run. If it
fails, the release still goes out and the notes say the OpenVINO asset is missing.
