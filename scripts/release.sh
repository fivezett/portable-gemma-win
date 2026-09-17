#!/usr/bin/env bash
#
# バージョンを上げてリリースを起動する。
#
#   ./scripts/release.sh 0.2.0            バージョンを上げてコミットするところまで
#   ./scripts/release.sh 0.2.0 --push     main に push してリリースまで走らせる
#
# main に push されると release ワークフローが
# 「package.json のバージョンにタグが無い」ことを検出してタグを打ち、GitHub Release を作る。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="$root/mcp-server/package.json"

version="${1:-}"
push="${2:-}"

if [ -z "$version" ]; then
  echo "使い方: $0 <version> [--push]" >&2
  echo "  例: $0 0.2.0" >&2
  exit 2
fi

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "バージョンの形式が不正です: $version (例: 0.2.0, 0.2.0-rc.1)" >&2
  exit 2
fi

current="$(node -p "require('$package').version")"
if [ "$current" = "$version" ]; then
  echo "既に $version です。" >&2
  exit 2
fi

if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "作業ツリーに未コミットの変更があります。先に整理してください。" >&2
  exit 2
fi

branch="$(git -C "$root" rev-parse --abbrev-ref HEAD)"

if git -C "$root" rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "タグ v$version は既に存在します。" >&2
  exit 2
fi

echo "==> $current -> $version"
node -e "
const fs = require('fs');
const path = '$package';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.version = '$version';
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

echo "==> 検証"
(
  cd "$root/mcp-server"
  bun install --frozen-lockfile >/dev/null
  bun run check
  bun test
)

git -C "$root" add "$package" mcp-server/bun.lock 2>/dev/null || git -C "$root" add "$package"
git -C "$root" commit -m "chore: v$version"

echo ""
echo "v$version のコミットを作成しました (ブランチ: $branch)"

if [ "$push" = "--push" ]; then
  if [ "$branch" != "main" ]; then
    echo "main 以外のブランチでは自動リリースは起動しません。PR をマージしてください。" >&2
  fi
  echo "==> push"
  git -C "$root" push origin "$branch"
  echo ""
  echo "release ワークフローがタグ v$version を打ち、GitHub Release を作成します。"
else
  echo ""
  echo "次のいずれかでリリースされます:"
  echo "  git push origin $branch     # main なら自動でタグとリリースが作られる"
  echo "  git tag v$version && git push origin v$version   # タグ経由で明示的にリリース"
fi
