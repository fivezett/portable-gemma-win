@echo off
rem llama-server だけを手動起動する。WebUI (http://127.0.0.1:18080) の確認や
rem MCP を介さない動作チェックに使う。停止は Ctrl+C。
setlocal

set "ROOT=%~dp0.."
set "LLAMA_CACHE=%ROOT%\models"

if not exist "%ROOT%\runtime\llama\llama-server.exe" (
  echo llama-server.exe が見つかりません。先に scripts\fetch-runtime.ps1 を実行してください。
  exit /b 1
)

"%ROOT%\dist\gemma-mcp.exe" serve
if errorlevel 1 (
  echo.
  echo gemma-mcp.exe が無い、または失敗しました。llama-server を直接起動します。
  "%ROOT%\runtime\llama\llama-server.exe" --host 127.0.0.1 --port 18080 -hf unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL -c 16384 -ngl 99 -fa on --jinja --alias gemma
)

endlocal
