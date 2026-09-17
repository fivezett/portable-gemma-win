# CI / CD とリリース

## ワークフロー

| ファイル | 役割 |
|---|---|
| `.github/workflows/build.yml` | 再利用可能ワークフロー。検査 → exe → zip / インストーラ |
| `.github/workflows/ci.yml` | push / PR で `build.yml` を呼ぶ |
| `.github/workflows/release.yml` | タグを打って GitHub Release を作る |

### build.yml (再利用可能)

3 つのジョブを直列に実行する。

1. **test** (ubuntu) — `bun install --frozen-lockfile` → 型チェック (TypeScript 7) → テスト。
   `package.json` のバージョンを出力として後続に渡す
2. **exe** (windows) — `bun run build:win:native` で単一 exe を生成する。
   Windows 上でビルドすることで `--windows-hide-console` が使え、
   MCP クライアントから起動されたときにコンソールが出ない。
   ビルド後に `--version` と `doctor` を実行して起動を確認する
3. **package** (ubuntu) — exe をダウンロードし、持ち運び用 zip と NSIS インストーラを作り、
   `SHA256SUMS.txt` を添えて artifact にする

exe の `--version` は `package.json` のバージョンと一致することを検証している。
バージョンの実体は `mcp-server/package.json` だけで、`src/index.ts` は
JSON import でそれを読む。二重管理にならない。

### release.yml

発火条件は 3 つ。

| 経路 | 動作 |
|---|---|
| `main` への push | `package.json` のバージョンにタグが無ければ、タグを打ってリリース |
| `v*` タグの push | そのタグでリリース (タグと `package.json` の不一致は失敗させる) |
| 手動実行 | バージョンを指定してリリース |

いずれの経路でも、タグが既に存在する場合は何もしない。二重リリースは起きない。

バージョンにハイフンが含まれる場合 (`0.2.0-rc.1` など) は自動的にプレリリース扱いになる。

リリースノートは `.github/release-notes-template.md` (ダウンロード表・セットアップ手順・
チェックサム) の後ろに、GitHub が生成したコミット一覧を連結して作る。

添付される成果物:

- `portable-gemma-setup-<version>.exe`
- `portable-gemma-win-x64-<version>.zip`
- `gemma-mcp.exe`
- `SHA256SUMS.txt`

## リリース手順

```bash
./scripts/release.sh 0.2.0
```

バージョンを書き換え、型チェックとテストを通してからコミットする。あとは:

```bash
git push origin main          # main なら自動でタグとリリースが作られる
```

PR 経由で進める場合は、バージョンを上げた PR を main にマージすれば同じことが起きる。
タグを明示したい場合は次でもよい。

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`./scripts/release.sh 0.2.0 --push` はコミットと push をまとめて行う。

## ローカルでのビルド

```bash
./scripts/build.sh
```

CI と同じ成果物を Linux 上で生成する。`bun build --compile --target=bun-windows-x64` で
クロスコンパイルし、`makensis` でインストーラを固める。

CI との違いは `--windows-hide-console` が付かないことだけ (このフラグは Windows 上でのみ指定できる)。
動作確認には影響しないが、配布する exe は CI のものを使うこと。

## 検査

CI の `lint` ジョブで次を実行している。ローカルでも同じものを回せる。

```bash
actionlint          # ワークフローの構文・式・run ブロック (ShellCheck 込み)
shellcheck scripts/*.sh
```
