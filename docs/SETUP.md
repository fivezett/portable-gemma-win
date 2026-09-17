# セットアップ詳細

## 1. GPU とランタイムの選択

llama.cpp は公式リリースで Windows 向けの CUDA ビルドを配布しており、
**CUDA ランタイム DLL (cudart) が同梱されている**。そのため CUDA Toolkit のインストールは不要で、
NVIDIA のグラフィックスドライバさえ入っていれば動く。

`scripts\fetch-runtime.ps1` は `nvidia-smi` で GPU の compute capability を調べ、
使うビルドを自動で決める。

| GPU 世代 | compute capability | 選択されるビルド |
|---|---|---|
| Blackwell (RTX 50xx) | 12.0 | `cuda-13.x` |
| Ada (RTX 40xx) | 8.9 | `cuda-13.x` |
| Ampere (RTX 30xx) | 8.6 | `cuda-13.x` |
| Turing (RTX 20xx / GTX 16xx) | 7.5 | `cuda-13.x` |
| Volta / Pascal / Maxwell | 7.0 以下 | `cuda-12.x` |

CUDA 13 は Maxwell / Pascal / Volta のサポートを打ち切っているため、
GTX 10xx 世代では CUDA 12 系のビルドが必要になる。明示したい場合:

```powershell
.\scripts\fetch-runtime.ps1 -Cuda 12 -Force
.\scripts\fetch-runtime.ps1 -Cuda 13.4 -Tag b11010   # バージョンを固定する
```

取得したバージョンは `runtime\llama\runtime-version.json` に記録される。

## 2. モデルの選定

Gemma 4 には E2B / E4B / 12B / 26B-A4B (MoE) / 31B がある。
量子化した GGUF を GPU に載せる前提での目安は次のとおり。

| モデル | Q4 相当の必要メモリ | 推奨 VRAM | コンテキスト |
|---|---|---|---|
| E2B | 約 3 GB | 4 GB〜 | 128K |
| **E4B (既定)** | 約 5 GB | **8 GB〜** | 128K |
| 12B | 約 8 GB | 12〜16 GB | 256K |
| 26B-A4B (MoE) | 約 18 GB | 24 GB〜 | 256K |
| 31B | 約 20 GB | 24 GB〜 | 256K |

**重みだけでなく KV キャッシュも VRAM を食う**点に注意する。コンテキストを伸ばすほど
KV キャッシュが増えるため、8 GB の GPU で 128K を張ろうとすると破綻する。
既定の `ctx = 16384` は 8 GB で E4B を無理なく動かすための値。

モデルを変えるには `config\gemma.toml` の `[model] hf` を書き換える:

```toml
[model]
hf = "unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL"

[runtime]
ctx = 8192    # 12B を 12 GB VRAM に載せるならコンテキストを絞る
```

QAT (Quantization Aware Training) 版は、同じビット数でも通常の量子化より劣化が小さい。
持ち運び用途では QAT 版を優先するとよい。

### モデルの置き場所

`LLAMA_CACHE` を `models\` に向けているため、`-hf` で取得したファイルはすべて
アプリのフォルダ配下に入る。**フォルダごとコピーすれば別の PC でもそのまま動く**。

オフラインの PC に持ち込む場合は、ネットのある PC で `fetch-model.ps1` まで済ませてから
フォルダ全体をコピーする。

ローカルの `.gguf` を直接指定することもできる:

```toml
[model]
path = "D:\\models\\gemma-4-E4B-it-Q4_K_M.gguf"
```

### gated なリポジトリ

Hugging Face 側でアクセス承認が必要なリポジトリを使う場合は、環境変数 `HF_TOKEN` を設定する。

## 3. 設定

`config\gemma.toml` を編集する。値の優先順位は次のとおり。

```
MCP クライアントが渡す環境変数 > OS の環境変数 > config\gemma.toml > 既定値
```

環境変数は `GEMMA_` 接頭辞で、すべての設定項目に対応している
(`GEMMA_PORT`, `GEMMA_MODEL_HF`, `GEMMA_CTX`, `GEMMA_NGL`, `GEMMA_MAX_TOKENS` など)。
MCP クライアントの設定ファイル側で上書きできるので、同じ exe を複数の設定で使い分けられる。

よく触る項目:

| 項目 | 意味 | 調整の指針 |
|---|---|---|
| `runtime.ctx` | コンテキスト長 | VRAM が足りなければ減らす |
| `runtime.ngl` | GPU に載せる層数 | 99 = 全部。溢れるなら減らして CPU に逃がす |
| `sampling.max_tokens` | 1 回の生成上限 | 長文生成が切れるなら増やす |
| `timeouts.startup_ms` | 起動待ちの上限 | 初回ダウンロードが間に合わないなら増やす |
| `server.parallel` | 同時処理スロット | VRAM を食うので 8 GB では 1 のまま |

## 4. 動作確認

```powershell
.\gemma-mcp.exe doctor
```

GPU、ランタイム、CUDA DLL、モデル、llama-server の応答、設定ファイルをまとめて確認できる。

WebUI で手触りを見たい場合:

```powershell
.\scripts\start-llama-server.cmd
# ブラウザで http://127.0.0.1:18080
```

## トラブルシューティング

### `llama-server が見つかりません`

`scripts\fetch-runtime.ps1` を実行していない。実行しても失敗する場合は、
GitHub API のレート制限 (未認証で 1 時間 60 回) の可能性があるため、
`GITHUB_TOKEN` を設定して再試行する。

### 起動はするが極端に遅い

GPU に載っていない。`doctor` で CUDA ランタイム DLL が見つかっているか確認し、
`logs\gemma-mcp.log` に `CUDA` のデバイス情報が出ているかを見る。
DLL が無い場合は `fetch-runtime.ps1 -Force` で取り直す。

### `out of memory` で落ちる

VRAM が足りない。順に試す:

1. `runtime.ctx` を減らす (16384 → 8192 → 4096)
2. より小さいモデルにする (12B → E4B → E2B)
3. `runtime.ngl` を減らして一部を CPU に逃がす (99 → 24 など)

### 初回のツール呼び出しがタイムアウトする

モデルのダウンロードが `timeouts.startup_ms` に収まっていない。
先に `fetch-model.ps1` でダウンロードを済ませるか、`startup_ms` を増やす。

### llama-server が残り続ける

通常は MCP クライアントが `gemma-mcp.exe` を終了させると Job Object の働きで
`llama-server.exe` も道連れで終了する。それでも残る場合は次で止める。

```powershell
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process
```

なお、`scripts\start-llama-server.cmd` などで**手動起動した llama-server は
MCP サーバーの管理外**なので、道連れ終了の対象にならない (意図的な仕様)。

### ログ

`logs\gemma-mcp.log` に MCP サーバーと llama-server の両方の出力が入る。
詳細が必要なら `config\gemma.toml` の `[log] level = "debug"` にする。
