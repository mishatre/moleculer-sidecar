<#
.SYNOPSIS
    Registers the packaged moleculer-sidecar binary as a Windows service (NSSM).

.DESCRIPTION
    A plain .exe cannot talk to the Service Control Manager: the process must
    call StartServiceCtrlDispatcher and report status, otherwise Windows fails
    the start with error 1053 after ~30s. NSSM wraps the binary and does that.

    Stopping the service sends a console Ctrl+C; the CLI handles it, stops the
    broker and exits 0, so NSSM treats the shutdown as clean.

.EXAMPLE
    # minimal install (writes state to %ProgramData%\moleculer-sidecar)
    .\install-service.ps1 -BinaryPath C:\srv\sidecar\moleculer-sidecar-win-x64.exe

.EXAMPLE
    # with a NATS bus and the lab agent on an external PostgreSQL
    .\install-service.ps1 -Environment @{
        TRANSPORTER = 'nats://nats:4222'
        NAMESPACE   = 'veamosl-services'
        LAB_PG_URL  = 'postgres://sidecar:secret@pg:5432/lab'
    } -Arguments '--lab'
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$ServiceName = 'moleculer-sidecar',
    [string]$DisplayName = 'Moleculer Sidecar',
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath,
    [string]$NssmPath = (Join-Path $PSScriptRoot 'nssm.exe'),
    [string]$DataDir = (Join-Path $env:ProgramData 'moleculer-sidecar'),
    [string]$LogDir = (Join-Path $env:ProgramData 'moleculer-sidecar\logs'),
    [string[]]$Arguments = @(),
    [hashtable]$Environment = @{},
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script from an elevated PowerShell session.'
    }
}

function Get-OrFetchNssm {
    if (Test-Path $NssmPath) { return $NssmPath }

    $bundled = Join-Path $PSScriptRoot 'nssm.exe'
    if (Test-Path $bundled) { return $bundled }

    Write-Host "nssm.exe not found at $NssmPath" -ForegroundColor Yellow
    Write-Host 'Install it with "choco install nssm" or download it from https://nssm.cc/download,'
    Write-Host 'then place nssm.exe next to this script or pass -NssmPath.'
    throw 'nssm.exe is required to register the service.'
}

Assert-Admin

$nssm = Get-OrFetchNssm
$binary = (Resolve-Path $BinaryPath).Path
if (-not (Test-Path $binary)) { throw "binary not found: $BinaryPath" }

foreach ($dir in @($DataDir, $LogDir)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if (-not $Force) {
        throw "service '$ServiceName' already exists — pass -Force to reinstall it"
    }
    Write-Host "Removing the existing service '$ServiceName'..." -ForegroundColor Yellow
    if ($existing.Status -ne 'Stopped') { & $nssm stop $ServiceName | Out-Null }
    & $nssm remove $ServiceName confirm | Out-Null
}

Write-Host "Installing service '$ServiceName' -> $binary"
& $nssm install $ServiceName $binary | Out-Null

# Arguments the CLI receives (e.g. --lab, --node-id, --transporter).
if ($Arguments.Count -gt 0) {
    & $nssm set $ServiceName AppParameters ($Arguments -join ' ') | Out-Null
}

# Never leave the working directory implicit: services start in System32.
& $nssm set $ServiceName AppDirectory $DataDir | Out-Null
& $nssm set $ServiceName DisplayName $DisplayName | Out-Null
& $nssm set $ServiceName Description 'Moleculer sidecar broker (single-file build)' | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null

# DATA_DIR keeps the SQLite files out of the snapshot/cwd; the native cache is
# where the packaged sqlite3 binding is extracted on first start.
$envPairs = @(
    "DATA_DIR=$DataDir",
    "PKG_NATIVE_CACHE_PATH=$(Join-Path $DataDir 'native')"
)
foreach ($key in $Environment.Keys) {
    $envPairs += "$key=$($Environment[$key])"
}
& $nssm set $ServiceName AppEnvironmentExtra @envPairs | Out-Null

& $nssm set $ServiceName AppStdout (Join-Path $LogDir "$ServiceName.out.log") | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $LogDir "$ServiceName.err.log") | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateOnline 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null

# Ctrl+C first (the CLI stops gracefully), then kill after 15s.
& $nssm set $ServiceName AppStopMethodConsole 15000 | Out-Null
& $nssm set $ServiceName AppStopMethodSkip 0 | Out-Null
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 5000 | Out-Null

Write-Host 'Starting the service...'
& $nssm start $ServiceName | Out-Null
Start-Sleep -Seconds 3
Get-Service -Name $ServiceName | Format-List Name, DisplayName, Status, StartType

Write-Host ''
Write-Host "Data directory : $DataDir"
Write-Host "Logs           : $LogDir"
Write-Host "Stop it with   : Stop-Service $ServiceName   (Ctrl+C based, graceful)"
