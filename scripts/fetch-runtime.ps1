<#
.SYNOPSIS
    llama.cpp の Windows バイナリ(CUDA 版)と CUDA ランタイム DLL を取得して runtime/llama に展開する。

.DESCRIPTION
    CUDA Toolkit のインストールは不要。公式リリースに同梱されている cudart を一緒に展開するため、
    必要なのは NVIDIA のグラフィックスドライバだけ。

    GPU の compute capability を nvidia-smi で判定し、7.5 未満(Pascal 以前)の場合は
    CUDA 13 が非対応なので自動的に CUDA 12 系のビルドにフォールバックする。

.PARAMETER Cuda
    使用する CUDA のバージョン。"auto"(既定)、"13"、"12"、"13.4" のように指定する。

.PARAMETER Tag
    llama.cpp のリリースタグ(例: b11010)。省略時は最新。

.PARAMETER Arch
    x64(既定)または arm64。

.PARAMETER Force
    既に展開済みでも再取得する。

.EXAMPLE
    .\fetch-runtime.ps1
.EXAMPLE
    .\fetch-runtime.ps1 -Cuda 12 -Force
#>
[CmdletBinding()]
param(
    [string]$Cuda = "auto",
    [string]$Tag = "",
    [ValidateSet("x64", "arm64")][string]$Arch = "x64",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root "runtime\llama"
$ReleasesApi = "https://api.github.com/repos/ggml-org/llama.cpp/releases"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Note($message) { Write-Host "    $message" -ForegroundColor DarkGray }

function Get-ComputeCapability {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) { return $null }
    try {
        $output = & nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $output) { return $null }
        $first = ($output | Select-Object -First 1).Trim()
        return [double]$first
    } catch {
        return $null
    }
}

function Resolve-CudaMajor {
    param([string]$Requested)

    if ($Requested -ne "auto") { return $Requested }

    $cap = Get-ComputeCapability
    if ($null -eq $cap) {
        Write-Note "nvidia-smi が使えないため CUDA 12 系を選択します(より広い GPU で動作します)"
        return "12"
    }
    Write-Note "GPU の compute capability: $cap"
    if ($cap -ge 7.5) {
        return "13"
    }
    Write-Note "CUDA 13 は compute capability 7.5 未満 (Pascal 以前) に非対応のため CUDA 12 系を選択します"
    return "12"
}

function Get-Releases {
    $headers = @{ "User-Agent" = "portable-gemma-win" }
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)" }

    if ($Tag -ne "") {
        return @(Invoke-RestMethod -Uri "$ReleasesApi/tags/$Tag" -Headers $headers)
    }
    # cudart が付いていないリリースもあるため、複数件さかのぼって探す
    return Invoke-RestMethod -Uri "${ReleasesApi}?per_page=15" -Headers $headers
}

function Select-Assets {
    param($Releases, [string]$CudaMajor)

    # "13" -> cuda-13.x のいずれか / "13.4" -> 完全一致
    $pattern = if ($CudaMajor -match '^\d+$') { "cuda-$CudaMajor\.\d+" } else { [regex]::Escape("cuda-$CudaMajor") }

    foreach ($release in $Releases) {
        $main = $release.assets | Where-Object { $_.name -match "^llama-.+-bin-win-$pattern-$Arch\.zip$" } | Select-Object -First 1
        if (-not $main) { continue }

        # main と同じ CUDA バージョンの cudart を選ぶ
        if ($main.name -match "bin-win-(cuda-\d+\.\d+)-") { $exactCuda = $Matches[1] } else { continue }
        $cudart = $release.assets | Where-Object { $_.name -eq "cudart-llama-bin-win-$exactCuda-$Arch.zip" } | Select-Object -First 1
        if (-not $cudart) {
            Write-Note "$($release.tag_name): $exactCuda の cudart が無いため次のリリースを見ます"
            continue
        }

        return [pscustomobject]@{
            Tag    = $release.tag_name
            Cuda   = $exactCuda
            Main   = $main
            Cudart = $cudart
        }
    }
    return $null
}

function Save-And-Expand {
    param($Asset, [string]$Destination, [string]$TempDir)

    $zip = Join-Path $TempDir $Asset.name
    $sizeMb = [math]::Round($Asset.size / 1MB, 1)
    Write-Step "$($Asset.name) を取得します ($sizeMb MB)"
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $zip -UseBasicParsing

    Write-Note "展開中..."
    $staging = Join-Path $TempDir ([IO.Path]::GetFileNameWithoutExtension($Asset.name))
    Expand-Archive -Path $zip -DestinationPath $staging -Force

    # zip によっては 1 階層深い場合があるため、exe/dll のある階層を探して平坦化する
    $source = $staging
    $nested = Get-ChildItem -Path $staging -Directory
    if (-not (Get-ChildItem -Path $staging -Filter *.exe) -and -not (Get-ChildItem -Path $staging -Filter *.dll) -and $nested.Count -eq 1) {
        $source = $nested[0].FullName
    }

    Copy-Item -Path (Join-Path $source "*") -Destination $Destination -Recurse -Force
    Remove-Item $zip -Force
}

# ---- 実行 ----

$serverExe = Join-Path $RuntimeDir "llama-server.exe"
if ((Test-Path $serverExe) -and -not $Force) {
    Write-Host "既に展開済みです: $serverExe" -ForegroundColor Green
    Write-Host "再取得する場合は -Force を付けてください。"
    exit 0
}

$cudaMajor = Resolve-CudaMajor -Requested $Cuda
Write-Step "CUDA $cudaMajor 系のビルドを探します (arch=$Arch)"

$releases = Get-Releases
$selected = Select-Assets -Releases $releases -CudaMajor $cudaMajor
if (-not $selected) {
    throw "CUDA $cudaMajor / $Arch に一致するリリース資産が見つかりませんでした。-Tag でリリースを明示するか -Cuda を変えてください。"
}

Write-Note "リリース: $($selected.Tag) / $($selected.Cuda)"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$temp = Join-Path ([IO.Path]::GetTempPath()) ("gemma-runtime-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {
    Save-And-Expand -Asset $selected.Main -Destination $RuntimeDir -TempDir $temp
    Save-And-Expand -Asset $selected.Cudart -Destination $RuntimeDir -TempDir $temp
} finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $serverExe)) {
    throw "展開後も llama-server.exe が見つかりません: $RuntimeDir"
}

# 取得したバージョンを記録しておく(更新判断とトラブル報告用)
[pscustomobject]@{
    tag        = $selected.Tag
    cuda       = $selected.Cuda
    arch       = $Arch
    fetched_at = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -Path (Join-Path $RuntimeDir "runtime-version.json") -Encoding UTF8

Write-Host ""
Write-Host "完了しました。" -ForegroundColor Green
Write-Host "  $serverExe"
Write-Host "  llama.cpp $($selected.Tag) / $($selected.Cuda) / $Arch"
