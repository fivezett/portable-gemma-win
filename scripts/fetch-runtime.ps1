<#
.SYNOPSIS
    Download a llama.cpp runtime into runtime\, either the CUDA build or the OpenVINO build.

.DESCRIPTION
    CUDA (default): takes the official llama.cpp Windows release. No CUDA Toolkit needed,
    because those releases ship cudart alongside the binaries; an NVIDIA graphics driver is
    the only prerequisite. The GPU's compute capability decides which build to take, since
    CUDA 13 dropped support for anything below 7.5 (Pascal and older).

    OpenVINO: runs on Intel CPUs, integrated and discrete GPUs, and NPUs. Upstream ships no
    prebuilt Windows binaries for this backend, so the build is produced by this project's
    own CI and attached to its releases. This script downloads that asset.

.PARAMETER Backend
    cuda (default) or openvino.

.PARAMETER Repo
    OpenVINO only: the GitHub repository holding the runtime asset.

.PARAMETER Cuda
    CUDA version to use: "auto" (default), "13", "12", or an exact "13.4".

.PARAMETER Tag
    llama.cpp release tag such as b11010. Defaults to the latest release.

.PARAMETER Arch
    x64 (default) or arm64.

.PARAMETER Force
    Download again even when the runtime is already in place.

.EXAMPLE
    .\fetch-runtime.ps1
.EXAMPLE
    .\fetch-runtime.ps1 -Cuda 12 -Force
.EXAMPLE
    .\fetch-runtime.ps1 -Backend openvino
#>
[CmdletBinding()]
param(
    [ValidateSet("cuda", "openvino")][string]$Backend = "cuda",
    [string]$Repo = "fivezett/portable-gemma-win",
    [string]$Cuda = "auto",
    [string]$Tag = "",
    [ValidateSet("x64", "arm64")][string]$Arch = "x64",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = if ($Backend -eq "openvino") {
    Join-Path $Root "runtime\llama-openvino"
} else {
    Join-Path $Root "runtime\llama"
}
$ReleasesApi = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
$OwnReleasesApi = "https://api.github.com/repos/$Repo/releases"

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
        Write-Note "nvidia-smi is unavailable; choosing CUDA 12, which supports more GPUs"
        return "12"
    }
    Write-Note "GPU compute capability: $cap"
    if ($cap -ge 7.5) {
        return "13"
    }
    Write-Note "CUDA 13 does not support compute capability below 7.5 (Pascal and older); choosing CUDA 12"
    return "12"
}

function Get-Releases {
    $headers = @{ "User-Agent" = "portable-gemma-win" }
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)" }

    if ($Tag -ne "") {
        return @(Invoke-RestMethod -Uri "$ReleasesApi/tags/$Tag" -Headers $headers)
    }
    # Some releases ship no cudart, so look back through several of them.
    return Invoke-RestMethod -Uri "${ReleasesApi}?per_page=15" -Headers $headers
}

function Select-Assets {
    param($Releases, [string]$CudaMajor)

    # "13" matches any cuda-13.x; "13.4" is an exact match.
    $pattern = if ($CudaMajor -match '^\d+$') { "cuda-$CudaMajor\.\d+" } else { [regex]::Escape("cuda-$CudaMajor") }

    foreach ($release in $Releases) {
        $main = $release.assets | Where-Object { $_.name -match "^llama-.+-bin-win-$pattern-$Arch\.zip$" } | Select-Object -First 1
        if (-not $main) { continue }

        # Pair the cudart archive with the exact CUDA version of the main archive.
        if ($main.name -match "bin-win-(cuda-\d+\.\d+)-") { $exactCuda = $Matches[1] } else { continue }
        $cudart = $release.assets | Where-Object { $_.name -eq "cudart-llama-bin-win-$exactCuda-$Arch.zip" } | Select-Object -First 1
        if (-not $cudart) {
            Write-Note "$($release.tag_name): no cudart for $exactCuda; trying the next release"
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
    Write-Step "Downloading $($Asset.name) ($sizeMb MB)"
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $zip -UseBasicParsing

    Write-Note "Extracting..."
    $staging = Join-Path $TempDir ([IO.Path]::GetFileNameWithoutExtension($Asset.name))
    Expand-Archive -Path $zip -DestinationPath $staging -Force

    # Some archives nest everything one level deep; flatten to the level holding the binaries.
    $source = $staging
    $nested = Get-ChildItem -Path $staging -Directory
    if (-not (Get-ChildItem -Path $staging -Filter *.exe) -and -not (Get-ChildItem -Path $staging -Filter *.dll) -and $nested.Count -eq 1) {
        $source = $nested[0].FullName
    }

    Copy-Item -Path (Join-Path $source "*") -Destination $Destination -Recurse -Force
    Remove-Item $zip -Force
}

function Install-OpenvinoRuntime {
    $headers = @{ "User-Agent" = "portable-gemma-win" }
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)" }

    $uri = if ($Tag -ne "") { "$OwnReleasesApi/tags/$Tag" } else { "$OwnReleasesApi/latest" }
    Write-Step "Looking for the OpenVINO runtime asset in $Repo"

    try {
        $release = Invoke-RestMethod -Uri $uri -Headers $headers
    } catch {
        throw "Could not read the releases of ${Repo}: $($_.Exception.Message)"
    }

    $asset = $release.assets | Where-Object { $_.name -match "^llama-openvino-.*win-$Arch\.zip$" } | Select-Object -First 1
    if (-not $asset) {
        throw @"
Release $($release.tag_name) has no OpenVINO runtime asset for $Arch.
The OpenVINO build is produced by the 'openvino-runtime' workflow; run it for this release,
or pass -Tag to pick a release that already has the asset.
"@
    }

    Write-Note "Release: $($release.tag_name) / $($asset.name)"
    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("gemma-openvino-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    try {
        Save-And-Expand -Asset $asset -Destination $RuntimeDir -TempDir $temp
    } finally {
        Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    }

    $serverExe = Join-Path $RuntimeDir "llama-server.exe"
    if (-not (Test-Path $serverExe)) {
        throw "llama-server.exe is still missing after extraction: $RuntimeDir"
    }

    Write-Host ""
    Write-Host "Done." -ForegroundColor Green
    Write-Host "  $serverExe"
    Write-Host "  llama.cpp with the OpenVINO backend ($($release.tag_name))"
    Write-Host ""
    Write-Host "Set the backend in config\gemma.toml:" -ForegroundColor Cyan
    Write-Host "  [runtime]"
    Write-Host '  backend = "openvino"'
    Write-Host "  [openvino]"
    Write-Host '  device = "GPU"   # CPU / GPU / NPU'
}

# ---- main ----

$serverExe = Join-Path $RuntimeDir "llama-server.exe"
if ((Test-Path $serverExe) -and -not $Force) {
    Write-Host "Already installed: $serverExe" -ForegroundColor Green
    Write-Host "Pass -Force to download it again."
    exit 0
}

if ($Backend -eq "openvino") {
    Install-OpenvinoRuntime
    exit 0
}

$cudaMajor = Resolve-CudaMajor -Requested $Cuda
Write-Step "Looking for a CUDA $cudaMajor build (arch=$Arch)"

$releases = Get-Releases
$selected = Select-Assets -Releases $releases -CudaMajor $cudaMajor
if (-not $selected) {
    throw "No release asset matched CUDA $cudaMajor / $Arch. Pin a release with -Tag or pick another -Cuda."
}

Write-Note "Release: $($selected.Tag) / $($selected.Cuda)"

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
    throw "llama-server.exe is still missing after extraction: $RuntimeDir"
}

# Record what was installed, for upgrade decisions and bug reports.
[pscustomobject]@{
    tag        = $selected.Tag
    cuda       = $selected.Cuda
    arch       = $Arch
    fetched_at = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -Path (Join-Path $RuntimeDir "runtime-version.json") -Encoding UTF8

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  $serverExe"
Write-Host "  llama.cpp $($selected.Tag) / $($selected.Cuda) / $Arch"
