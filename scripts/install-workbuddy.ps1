#Requires -Version 5.1
<#
.SYNOPSIS
    Install or refresh the WorkBuddy GetY connector.

.DESCRIPTION
    Copies workbuddy/connector to %LOCALAPPDATA%\GetYWorkBuddyConnector\connector,
    then installs, enables, restarts, and polls it through the local GetY CLI.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-workbuddy.ps1
#>
[CmdletBinding()]
param(
    [string]$GetyExe = $env:GETY_EXE,
    [string]$ConnectorId
)

$ErrorActionPreference = "Stop"

function Find-Gety {
    param([string]$Explicit)
    $candidates = @()
    if ($Explicit) { $candidates += $Explicit }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Gety\Gety.exe") }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Gety\Gety.exe") }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Gety\Gety.exe") }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "GetY.exe not found. Set GETY_EXE or pass -GetyExe."
}

function Invoke-Gety {
    param([string]$Exe, [string[]]$Arguments)
    $output = & $Exe @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "gety $($Arguments -join ' ') failed:`n$output"
    }
    return $output
}

function Get-ConnectorId {
    param([string]$Exe)
    $raw = Invoke-Gety -Exe $Exe -Arguments @("connector", "list", "--json", "--kind", "all")
    $list = $raw | ConvertFrom-Json
    $match = $list | Where-Object { $_.type_key -eq "workbuddy_sessions" } | Select-Object -First 1
    if ($match) { return $match.id }
    return $null
}

$gety = Find-Gety -Explicit $GetyExe
Write-Host "GetY:      $gety"

$source = (Resolve-Path (Join-Path $PSScriptRoot "..\workbuddy\connector")).Path
if (-not (Test-Path -LiteralPath (Join-Path $source "manifest.json"))) {
    throw "Connector manifest not found under $source"
}
if (-not (Test-Path -LiteralPath (Join-Path $source "dist\main.js"))) {
    throw "dist/main.js is missing. Run 'deno task build' in workbuddy/connector first."
}

$destRoot = Join-Path $env:LOCALAPPDATA "GetYWorkBuddyConnector"
$dest = Join-Path $destRoot "connector"
New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
Write-Host "Connector: $dest"

if (-not $ConnectorId) { $ConnectorId = Get-ConnectorId -Exe $gety }
if ($ConnectorId) {
    Write-Host "Reusing connector $ConnectorId"
    Invoke-Gety -Exe $gety -Arguments @("connector", "configure", $ConnectorId, "--json") | Out-Null
} else {
    $raw = Invoke-Gety -Exe $gety -Arguments @("connector", "install", $dest, "--json")
    $installed = $raw | ConvertFrom-Json
    $ConnectorId = $installed.connector_id
    if (-not $ConnectorId) { $ConnectorId = Get-ConnectorId -Exe $gety }
    if (-not $ConnectorId) { throw "GetY did not return a connector id.`n$raw" }
    Write-Host "Installed connector $ConnectorId"
}

Invoke-Gety -Exe $gety -Arguments @("connector", "enable", $ConnectorId, "--json") | Out-Null
Invoke-Gety -Exe $gety -Arguments @("connector", "restart", $ConnectorId, "--json") | Out-Null
Invoke-Gety -Exe $gety -Arguments @("connector", "poll", $ConnectorId, "--json") | Out-Null

$show = Invoke-Gety -Exe $gety -Arguments @("connector", "show", $ConnectorId, "--json") | ConvertFrom-Json
Write-Host ""
Write-Host "WorkBuddy connector ready."
Write-Host "  id:    $ConnectorId"
Write-Host "  state: $($show.status.state)"
Write-Host "  docs:  $($show.searchable_doc_count)"
Write-Host ""
Write-Host "Open GetY and search a WorkBuddy session title or prompt."
