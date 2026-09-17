# portable-gemma-win

Windows で持ち運べる **Gemma 4 + llama.cpp (CUDA)** 環境。
ローカルの Gemma を **MCP サーバー**として公開し、Claude Code などの MCP クライアントから
ツールとして呼び出せるようにする。

- **インストール不要な構成**: CUDA Toolkit も Node.js も要らない。必要なのは NVIDIA のドライバだけ
- **フォルダごと持ち運べる**: 実行ファイル・ランタイム・モデル・設定がすべて 1 つのフォルダに収まる
- **課金なし・外部送信なし**: 推論はすべてローカルの GPU で走る

```
MCP クライアント (Claude Code など)
        │  stdio / JSON-RPC
        ▼
   gemma-mcp.exe          ← Bun で単一 exe 化した MCP サーバー
        │  HTTP (127.0.0.1)
        ▼
   llama-server.exe       ← llama.cpp 公式 Windows CUDA ビルド
        │
        ▼
   Gemma 4 (GGUF)
```

## 必要なもの

| 項目 | 条件 |
|---|---|
| OS | Windows 10 / 11 (x64) |
| GPU | NVIDIA。CUDA 13 ビルドは **Turing 世代 (GTX 1600 / RTX 2000) 以降**が必須 |
| ドライバ | NVIDIA グラフィックスドライバ。**CUDA Toolkit は不要** |
| VRAM | 8 GB で Gemma 4 E4B (Q4) が動く。12 GB 以上あれば 12B も選べる |
| ディスク | ランタイム約 300 MB + モデル 3〜8 GB |

Pascal 以前 (GTX 10xx など) は CUDA 13 の対象外なので、セットアップスクリプトが
自動的に CUDA 12 系のビルドにフォールバックする。

## セットアップ

### インストーラを使う場合

`portable-gemma-setup-<version>.exe` を実行する。管理者権限は不要で、既定では
`%LOCALAPPDATA%\PortableGemma` に入る。ランタイムとモデルの取得もインストーラから実行できる。

### zip を展開する場合

```powershell
# 1. 任意の場所に展開する (USB メモリでも可)
# 2. llama.cpp のランタイムを取得する
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-runtime.ps1

# 3. モデルを取得する (省略可。初回のツール呼び出し時に自動取得される)
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-model.ps1

# 4. 環境を確認する
.\gemma-mcp.exe doctor
```

## MCP クライアントへの登録

```bash
claude mcp add gemma -- "C:\path\to\gemma-mcp.exe"
```

設定ファイルで登録する場合:

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

`gemma-mcp.exe print-config` でこの JSON を出力できる。詳細は [docs/MCP.md](docs/MCP.md)。

## 公開されるツール

| ツール | 用途 |
|---|---|
| `gemma_ask` | 単発の質問・指示。要約や下書きなど |
| `gemma_chat` | 会話履歴を渡して続きを生成する |
| `gemma_json` | JSON Schema を渡して構造化出力を強制する |
| `gemma_vision` | 画像について質問する (mmproj が必要) |
| `gemma_status` | モデルやコンテキスト長など、稼働状態を返す |

## フォルダ構成

```
PortableGemma/
├── gemma-mcp.exe              MCP サーバー本体
├── mcp-config.json            MCP クライアント用の設定 (インストーラが生成)
├── config/gemma.toml          設定ファイル
├── runtime/llama/             llama.cpp のバイナリと CUDA DLL
├── models/                    GGUF (LLAMA_CACHE)
├── logs/gemma-mcp.log         ログ
├── scripts/                   取得・起動スクリプト
└── docs/                      ドキュメント
```

## ドキュメント

- [docs/SETUP.md](docs/SETUP.md) — セットアップ詳細、モデル選定、トラブルシューティング
- [docs/MCP.md](docs/MCP.md) — MCP クライアントへの登録とツールの仕様
- [docs/SPEC.md](docs/SPEC.md) — 設計と、そう決めた理由
- [docs/RELEASE.md](docs/RELEASE.md) — CI / CD とリリース手順

## 開発

```bash
cd mcp-server
bun install
bun test          # モックの llama-server に対する stdio 越しの結合テスト
bun run check     # 型チェック (TypeScript 7)
cd .. && ./scripts/build.sh   # exe / zip / インストーラを生成
```

リリースは `mcp-server/package.json` のバージョンを上げて `main` に push するだけで、
タグの作成から GitHub Release の公開まで自動で走る。詳細は [docs/RELEASE.md](docs/RELEASE.md)。

```bash
./scripts/release.sh 0.2.0
git push origin main
```

## ライセンス

このリポジトリのコードは MIT。
llama.cpp (MIT) と Gemma 4 (Apache-2.0) はそれぞれのライセンスに従う。
