## ダウンロード

| ファイル | 用途 |
|---|---|
| `portable-gemma-setup-{{VERSION}}.exe` | インストーラ。管理者権限不要で `%LOCALAPPDATA%` に入る |
| `portable-gemma-win-x64-{{VERSION}}.zip` | 持ち運び用。任意の場所に展開する (USB 可) |
| `gemma-mcp.exe` | MCP サーバー本体のみ |
| `SHA256SUMS.txt` | チェックサム |

## セットアップ

```powershell
# 展開後、llama.cpp のランタイムを取得する
# (GPU の compute capability を見て CUDA 13 / 12 を自動選択)
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-runtime.ps1

# 環境を確認する
.\gemma-mcp.exe doctor

# MCP クライアント用の設定を出力する
.\gemma-mcp.exe print-config
```

モデルは初回のツール呼び出し時に自動でダウンロードされる。
先に取得しておく場合は `scripts\fetch-model.ps1` を実行する。

動作要件と設定の詳細は [docs/SETUP.md](https://github.com/{{REPOSITORY}}/blob/{{TAG}}/docs/SETUP.md)、
MCP クライアントへの登録は [docs/MCP.md](https://github.com/{{REPOSITORY}}/blob/{{TAG}}/docs/MCP.md) を参照。

### チェックサム

```
{{CHECKSUMS}}
```

---

