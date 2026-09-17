# MCP クライアントへの登録とツール仕様

## 登録

`gemma-mcp.exe` は **stdio トランスポート**の MCP サーバーとして動く。
MCP クライアントがプロセスを起動し、標準入出力で JSON-RPC をやり取りする。
ポートを開けたり、先に何かを起動しておく必要はない。

### Claude Code

```bash
claude mcp add gemma -- "C:\Users\<user>\AppData\Local\PortableGemma\gemma-mcp.exe"
```

### 設定ファイルで登録する場合

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

`gemma-mcp.exe print-config` で自分の環境に合わせた JSON を出力できる
(インストーラは同じ内容を `mcp-config.json` に書き出す)。

`GEMMA_HOME` は省略してもよい。省略した場合は **exe の置かれているフォルダ**が
アプリのルートとして使われる。exe だけを別の場所にコピーした場合は明示する。

### 環境変数で設定を上書きする

同じ exe を別の設定で登録できる。例: 重いモデルを長いコンテキストで使う「熟考用」を別枠にする。

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

**ポートは必ず分ける**。同じポートを指定すると、後から呼ばれた方が
「既に起動している別モデルの llama-server」に接続してしまう。

## 起動と終了のふるまい

- ツールが最初に呼ばれた時点で `llama-server` を自動起動する (遅延起動)。
  MCP クライアントの起動時に GPU を掴むことはない
- 指定ポートで **既に llama-server が応答していれば、それを使う**。
  二重にモデルをロードして VRAM を溶かすことはない
- 自分で起動したプロセスだけを終了させる。手動起動したものには触らない
- MCP クライアントに強制終了された場合も、Windows の Job Object により
  `llama-server` が道連れで終了する。VRAM を掴んだ孤児プロセスは残らない

## ツール

### `gemma_ask`

単発の質問・指示。会話は保持しない。

| 引数 | 型 | 説明 |
|---|---|---|
| `prompt` | string (必須) | 指示または質問 |
| `system` | string | システムプロンプト |
| `temperature` / `top_p` / `top_k` | number | サンプリング。省略時は設定値 |
| `max_tokens` | number | 生成上限 |
| `stop` | string[] | 打ち切り文字列 (最大 8 件) |

### `gemma_chat`

会話履歴を渡して続きを生成する。**サーバーは状態を持たない**ため、
呼び出し側が `messages` に全履歴を含める。

| 引数 | 型 | 説明 |
|---|---|---|
| `messages` | `{role, content}[]` (必須) | 古い順の会話履歴。role は `system` / `user` / `assistant` |
| その他 | | `gemma_ask` と同じ |

### `gemma_json`

JSON Schema を渡し、それに従う JSON だけを生成させる。
llama.cpp 側で文法を強制するため、スキーマから外れた出力は構造的に発生しない。
`temperature` の既定は 0。

| 引数 | 型 | 説明 |
|---|---|---|
| `prompt` | string (必須) | 抽出・分類の指示 |
| `schema` | object (必須) | JSON Schema |
| `system` | string | |
| `temperature` / `max_tokens` | number | |

```json
{
  "prompt": "次のレビューを分類して: 起動は速いが電池の持ちが悪い",
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

画像について質問する。`image_path` か `image_base64` のどちらかが必要。
マルチモーダル用の projector (mmproj) が読み込まれている必要がある。

| 引数 | 型 | 説明 |
|---|---|---|
| `prompt` | string (必須) | 画像への質問 |
| `image_path` | string | ローカル画像の絶対パス |
| `image_base64` | string | base64 データ |
| `mime_type` | string | `image_base64` を使うときの MIME タイプ |

### `gemma_status`

稼働状態を構造化して返す。生成が失敗するときの切り分けに使う。

返り値: `running` / `managed` / `endpoint` / `model` / `context_size` / `configured_model` / `autostart`

## 長時間の生成

ローカル推論は数十秒から数分かかる。クライアントが `_meta.progressToken` を渡してきた場合、
`gemma-mcp` は **ストリーミングで受信しながら進捗通知 (`notifications/progress`) を送る**。
進捗値は生成済みの文字数。

クライアントがリクエストをキャンセルした場合は `AbortSignal` が
llama-server への HTTP リクエストまで伝播し、生成が止まる。
暴走した生成を放置せずに済む。

タイムアウトは `config\gemma.toml` の `timeouts.request_ms` (既定 600 秒)。

## 使いどころ

Claude などの上位エージェントから見ると、`gemma` は
**「無料で無制限に叩けるが、賢さは控えめな下請け」**として使うのが噛み合う。

- 大量のテキストの一次要約・分類・タグ付け
- 外部に出したくない内容の下処理
- ログやエラーメッセージの整形
- API 課金を使うほどでもない定型処理

逆に、複雑な推論や長い依存関係のあるコード生成を丸ごと任せる用途には向かない。
