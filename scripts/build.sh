#!/usr/bin/env bash
#
# 配布物を作る。
#   dist/gemma-mcp.exe                      単一実行ファイル
#   dist/portable-gemma-win-x64-<ver>.zip   USB などに置く持ち運び用
#   dist/portable-gemma-setup-<ver>.exe     NSIS インストーラ (makensis があるときのみ)
#
# Linux からのクロスビルドが前提。Windows 上で実行する場合は
# mcp-server の build:win:native を使うとアイコンとコンソール非表示が付く。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$root/dist"
staging="$root/build/staging"
version="$(node -p "require('$root/mcp-server/package.json').version")"

echo "==> portable-gemma-win $version をビルドします"

echo "==> 依存関係"
(cd "$root/mcp-server" && bun install --frozen-lockfile 2>/dev/null || bun install)

echo "==> 型チェック"
(cd "$root/mcp-server" && bun run check)

echo "==> テスト"
(cd "$root/mcp-server" && bun test)

echo "==> gemma-mcp.exe"
rm -rf "$dist" "$root/build"
mkdir -p "$dist"
(cd "$root/mcp-server" && bun run build:win)

echo "==> ステージング"
mkdir -p "$staging"
cp "$dist/gemma-mcp.exe" "$staging/"
cp "$root/README.md" "$staging/"
mkdir -p "$staging/scripts" "$staging/docs" "$staging/config"
cp "$root/scripts/fetch-runtime.ps1" "$root/scripts/fetch-model.ps1" "$root/scripts/start-llama-server.cmd" "$staging/scripts/"
cp "$root/docs/"*.md "$staging/docs/"
cp "$root/config/gemma.toml.example" "$staging/config/"

echo "==> 持ち運び用 zip"
(cd "$staging" && zip -qr "$dist/portable-gemma-win-x64-$version.zip" .)

if command -v makensis >/dev/null 2>&1; then
  echo "==> NSIS インストーラ"
  makensis -V2 "-DSTAGING=$staging" "-DVERSION=$version" "$root/installer/portable-gemma.nsi"
else
  echo "==> makensis が無いためインストーラはスキップします"
fi

echo ""
echo "完了しました:"
ls -lh "$dist"
