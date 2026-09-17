## Downloads

| File | What it is |
|---|---|
| `portable-gemma-setup-{{VERSION}}.exe` | Installer. No administrator rights; installs into `%LOCALAPPDATA%` |
| `portable-gemma-win-x64-{{VERSION}}.zip` | Portable folder. Extract anywhere, including a USB stick |
| `gemma-mcp.exe` | The MCP server on its own |
| `SHA256SUMS.txt` | Checksums |

{{OPENVINO}}

## Setup

```powershell
# After extracting, fetch the llama.cpp runtime.
# The GPU's compute capability decides between the CUDA 13 and CUDA 12 builds.
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-runtime.ps1

# Check the environment
.\gemma-mcp.exe doctor

# Print the configuration for your MCP client
.\gemma-mcp.exe print-config
```

The model downloads on the first tool call. To fetch it ahead of time, run
`scripts\fetch-model.ps1`.

On Intel hardware, fetch the OpenVINO runtime instead and switch the backend:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-runtime.ps1 -Backend openvino
```

See [docs/SETUP.md](https://github.com/{{REPOSITORY}}/blob/{{TAG}}/docs/SETUP.md) for
requirements and configuration, and
[docs/MCP.md](https://github.com/{{REPOSITORY}}/blob/{{TAG}}/docs/MCP.md) for registering
the server with an MCP client.

### Checksums

```
{{CHECKSUMS}}
```

---

