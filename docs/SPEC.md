# 設計と、そう決めた理由

## 全体構成

```
MCP クライアント ──stdio/JSON-RPC── gemma-mcp.exe ──HTTP/127.0.0.1── llama-server.exe ── GGUF
```

`gemma-mcp.exe` は Bun でビルドした単一実行ファイル。Node.js のインストールを要求しない。
推論そのものは llama.cpp 公式の `llama-server.exe` に任せ、MCP との変換だけを担う。

## 推論を llama-server に任せる理由

検討した選択肢:

| 方式 | 判断 |
|---|---|
| **llama-server を子プロセスで起動し HTTP で叩く** | 採用 |
| `llama-cli` をリクエストごとに起動 | 却下。毎回モデルをロードし直すため、E4B でも一呼び出しが数秒〜十数秒の固定費になる |
| `node-llama-cpp` で同一プロセス内推論 | 却下。ネイティブアドオンを `bun build --compile` に埋め込むのが困難で、CUDA ビルドも二重管理になる |

llama-server 方式の副次的な利点:

- KV キャッシュがプロセスをまたいで生き続ける
- llama.cpp の WebUI がそのまま使える (動作確認が楽)
- マルチモーダル (mmproj) が公式サポートの範囲で動く
- llama.cpp 本体の更新に、スクリプトの取得先を変えるだけで追従できる

HTTP クライアントは Bun 内蔵の `fetch` のみを使い、OpenAI SDK は入れていない。
SSE の解析は 30 行程度で済み、依存を増やす価値がないため。

## MCP SDK

`@modelcontextprotocol/server` v2 (spec 2026-07-28) を採用。
`serveStdio()` は 2025 年世代のクライアントからの `initialize` も
そのまま処理する (`legacy: 'serve'` が既定) ため、互換性を落とさずに新しい仕様に乗れる。

スキーマは zod v4。`registerTool` に渡した zod スキーマから
JSON Schema の生成と引数の検証、ハンドラの型推論までが導かれる。

### 長時間実行を tasks にしなかった理由

当初は MCP v2 の tasks (`tasks/get`, `tasks/result`) で非同期化する想定だった。
しかし SDK 2.0.0 の実装を確認したところ、

- `registerTool` の設定オブジェクトは `execution`(= `taskSupport` の宣言)を**受け取らずに捨てる**
- タスクストアや `tasks/*` のハンドラは `McpServer` に**実装されていない**(スキーマ定義のみ)

つまり tasks に対応するには、プロトコルの下回りを自前で実装することになる。
クライアント側の対応状況も不透明なため、現時点では採用しない。

代わりに、SDK が完全にサポートしている次の 2 つで実用上の問題を潰している。

- **進捗通知**: クライアントが `_meta.progressToken` を渡してきたらストリーミングに切り替え、
  1 秒ごとに `notifications/progress` を送る。無反応に見える時間が無くなる
- **キャンセル**: ハンドラに渡る `AbortSignal` を `fetch` までそのまま流す。
  クライアントがキャンセルすれば llama-server 側の生成も止まる

将来 SDK が tasks を実装したら、ツールの中身を変えずに上に乗せられる。

## ステートレスにした理由

`conversation_id` をサーバー側で持つ案も検討したが、採用しなかった。

- MCP クライアント側は既に会話履歴を持っている。二重管理になる
- クライアントの再起動やセッション切り替えでサーバー側の状態が孤児になる
- 破棄のタイミングを決められず、GC とメモリリークの温床になる

`gemma_chat` に全履歴を渡す方式なら、これらの問題が構造的に発生しない。
トークンの再計算コストは llama.cpp のプレフィックスキャッシュがかなり吸収する。

## 孤児プロセス対策 (Windows Job Object)

MCP クライアントが `gemma-mcp.exe` を `TerminateProcess` で強制終了した場合、
JavaScript の終了ハンドラは走らない。そのままでは `llama-server.exe` が
VRAM を数 GB 掴んだまま生き残る。

対策として `bun:ffi` から kernel32 を直接叩き、
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` を設定した Job Object に子プロセスを入れている。
プロセスが死ねば OS がハンドルを閉じ、その時点で子も終了する。
強制終了でも確実に効くのはこの方法だけ。

FFI が使えない環境 (Windows 以外、DLL の読み込み失敗) では、
終了ハンドラによる停止にフォールバックし、警告をログに残す。

**自分が起動したプロセスしか止めない**という制約も入れてある。
手動で立てた llama-server や、別の MCP サーバーインスタンスが起動したものを
巻き添えにしないため。

## 設定ファイル形式

TOML を採用。`Bun.TOML.parse` が標準で使えるため依存が増えず、
コメント付きの設定テンプレートを配布できる。JSON はコメントが書けず、
`.env` は階層を表現できない。

優先順位は `環境変数 > TOML > 既定値`。
MCP クライアントの設定 JSON から `env` で上書きできることが重要で、
これにより 1 つの exe を複数のモデル設定で使い分けられる。

## ツールの粒度

`gemma_ask` / `gemma_chat` / `gemma_json` / `gemma_vision` / `gemma_status` の 5 本に絞った。

`gemma_summarize` や `gemma_translate` のようなタスク特化ツールは作っていない。
呼び出し側 (Claude など) が適切なプロンプトを書けるため、
ツールを増やしてもツール一覧を汚すだけで、能力は増えないと判断した。

## stdout の扱い

stdio トランスポートでは **stdout が JSON-RPC 専用**。
1 行でも余計な出力が混ざるとプロトコルが壊れる。

そのためロガーは stderr とファイルにしか書かない。
`llama-server` の標準出力も捕捉してログファイルに転記している。
この規約はテストでも検証していて、stdout に JSON 以外が流れたら失敗する。

## トランスポート

stdio のみ。Streamable HTTP も SDK でサポートされているが、

- 認証、CORS、ポート管理といった考慮事項が一気に増える
- ローカルで動かす前提なら stdio で足りる

という理由で入れていない。別 PC から使いたい要求が出たら、
`llama-server` 自体を LAN に出す方が素直。

## ビルドと配布

- **クロスビルド**: Linux から `bun build --compile --target=bun-windows-x64` で exe を生成できる。
  CI でも開発機でも同じ成果物が作れる
- **Windows でのビルド**: `--windows-icon` と `--windows-hide-console` は
  Windows 上でのみ指定できる。リリース用の exe は windows ランナーでビルドし、
  アイコンとコンソール非表示を付ける
- **配布形態**: 持ち運び用の zip と NSIS インストーラの両方。
  インストーラも管理者権限を要求せず `%LOCALAPPDATA%` に入れるため、
  インストール後もフォルダごと移動できる
- **モデルは同梱しない**: 数 GB あり、再配布の扱いも面倒になる。
  インストーラのオプションか、初回のツール呼び出し時に取得する

## テスト

`llama-server` のモックを立て、`gemma-mcp` を**実際に子プロセスとして起動して
stdio 越しに JSON-RPC を往復させる**結合テストを置いている。
Linux の CI でそのまま回るため、Windows 実機がなくても
ツールの引数変換、進捗通知、エラー処理、stdout の衛生を検証できる。

検証していない範囲 (実機が要る部分):

- CUDA ビルドの実行と GPU オフロード
- Job Object による道連れ終了
- PowerShell スクリプトと NSIS インストーラの実動作
