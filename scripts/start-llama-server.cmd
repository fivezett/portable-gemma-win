@echo off
rem Start llama-server by hand, for checking the web UI or testing without MCP in the way.
rem Stop it with Ctrl+C.
setlocal

set "ROOT=%~dp0.."
set "LLAMA_CACHE=%ROOT%\models"

if not exist "%ROOT%\runtime\llama\llama-server.exe" (
  echo llama-server.exe is missing. Run scripts\fetch-runtime.ps1 first.
  exit /b 1
)

"%ROOT%\gemma-mcp.exe" serve
if errorlevel 1 (
  echo.
  echo gemma-mcp.exe is missing or failed. Falling back to llama-server directly.
  "%ROOT%\runtime\llama\llama-server.exe" --host 127.0.0.1 --port 18080 -hf unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL -c 16384 -ngl 99 -fa on --jinja --alias gemma
)

endlocal
