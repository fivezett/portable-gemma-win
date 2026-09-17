<#
.SYNOPSIS
    Gemma の GGUF を models\ に取得する。

.DESCRIPTION
    llama.cpp の -hf 指定をそのまま使うため、分割 GGUF やマルチモーダル用 projector の
    解決も llama.cpp 側に任せられる。LLAMA_CACHE を models\ に向けているので、
    フォルダごと別の PC に持って行ってもそのまま動く。

    gated なリポジトリを使う場合は環境変数 HF_TOKEN を設定しておくこと。

.PARAMETER Model
    "<HF リポジトリ>:<量子化>" 形式。省略時は config\gemma.toml の model.hf を読む。

.PARAMETER Force
    キャッシュ済みでも再取得を試みる。

.EXAMPLE
    .\fetch-model.ps1
.EXAMPLE
    .\fetch-model.ps1 -Model "unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL"
#>
[CmdletBinding()]
param(
    [string]$Model = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root "runtime\llama"
$ModelsDir = Join-Path $Root "models"
$ConfigFile = Join-Path $Root "config\gemma.toml"
$DefaultModel = "unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Note($message) { Write-Host "    $message" -ForegroundColor DarkGray }

function Get-ConfiguredModel {
    if (-not (Test-Path $ConfigFile)) { return "" }
    $inModelSection = $false
    foreach ($line in Get-Content $ConfigFile) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[(.+)\]$') {
            $inModelSection = ($Matches[1] -eq "model")
            continue
        }
        if ($inModelSection -and $trimmed -match '^hf\s*=\s*"(.*)"') {
            return $Matches[1]
        }
    }
    return ""
}

function Get-CacheSize {
    if (-not (Test-Path $ModelsDir)) { return 0 }
    $files = Get-ChildItem -Path $ModelsDir -Recurse -File -ErrorAction SilentlyContinue
    if (-not $files) { return 0 }
    return ($files | Measure-Object -Property Length -Sum).Sum
}

# ---- 実行 ----

if ($Model -eq "") { $Model = Get-ConfiguredModel }
if ($Model -eq "") { $Model = $DefaultModel }

$cli = Join-Path $RuntimeDir "llama-cli.exe"
if (-not (Test-Path $cli)) {
    throw "llama-cli.exe が見つかりません: $cli`n先に .\fetch-runtime.ps1 を実行してください。"
}

New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
$env:LLAMA_CACHE = $ModelsDir

$before = Get-CacheSize
if ($before -gt 0 -and -not $Force) {
    Write-Note ("models\ に既に {0:N2} GiB あります(不足分だけ追加取得します)" -f ($before / 1GB))
}

Write-Step "モデルを取得します: $Model"
Write-Note "保存先: $ModelsDir"
if ($env:HF_TOKEN) { Write-Note "HF_TOKEN を使用します" }
Write-Note "初回は数 GB のダウンロードになります。完了まで待ってください。"

# -ngl 0 / -n 0 で GPU も生成も使わず、ダウンロードと読み込み確認だけを行う
& $cli -hf $Model -ngl 0 -n 0 --no-warmup -p "" 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
$exitCode = $LASTEXITCODE

$after = Get-CacheSize
if ($after -le $before -and $after -eq 0) {
    throw "ダウンロードに失敗しました (llama-cli の終了コード: $exitCode)。リポジトリ名と量子化名、ネットワーク、HF_TOKEN を確認してください。"
}

Write-Host ""
Write-Host "完了しました。" -ForegroundColor Green
Write-Host ("  models\ の合計: {0:N2} GiB" -f ($after / 1GB))
if ($exitCode -ne 0) {
    Write-Host "  (llama-cli は $exitCode で終了しましたが、ファイルは取得できています)" -ForegroundColor Yellow
}
