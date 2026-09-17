<#
.SYNOPSIS
    Download a Gemma GGUF into models\.

.DESCRIPTION
    Uses llama.cpp's own -hf handling, so sharded GGUFs and multimodal projectors are
    resolved by llama.cpp rather than by this script. LLAMA_CACHE points at models\, which
    means the whole folder can be copied to another machine and still work.

    Set HF_TOKEN when the repository requires accepting a licence.

.PARAMETER Model
    "<hf repo>:<quantisation>". Defaults to model.hf from config\gemma.toml.

.PARAMETER Force
    Try again even when something is already cached.

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

# ---- main ----

if ($Model -eq "") { $Model = Get-ConfiguredModel }
if ($Model -eq "") { $Model = $DefaultModel }

$cli = Join-Path $RuntimeDir "llama-cli.exe"
if (-not (Test-Path $cli)) {
    throw "llama-cli.exe not found at $cli`nRun .\fetch-runtime.ps1 first."
}

New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
$env:LLAMA_CACHE = $ModelsDir

$before = Get-CacheSize
if ($before -gt 0 -and -not $Force) {
    Write-Note ("models\ already holds {0:N2} GiB; only missing files are fetched" -f ($before / 1GB))
}

Write-Step "Fetching model: $Model"
Write-Note "Destination: $ModelsDir"
if ($env:HF_TOKEN) { Write-Note "Using HF_TOKEN" }
Write-Note "The first run downloads several GB. Let it finish."

# -ngl 0 with -n 0 touches neither the GPU nor generation: it only downloads and loads.
& $cli -hf $Model -ngl 0 -n 0 --no-warmup -p "" 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
$exitCode = $LASTEXITCODE

$after = Get-CacheSize
if ($after -le $before -and $after -eq 0) {
    throw "Download failed (llama-cli exited with $exitCode). Check the repository and quantisation names, the network, and HF_TOKEN."
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ("  models\ total: {0:N2} GiB" -f ($after / 1GB))
if ($exitCode -ne 0) {
    Write-Host "  (llama-cli exited with $exitCode, but the files were downloaded)" -ForegroundColor Yellow
}
