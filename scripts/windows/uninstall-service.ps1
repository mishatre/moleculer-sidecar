<#
.SYNOPSIS
    Unregisters the moleculer-sidecar Windows service.

.EXAMPLE
    .\uninstall-service.ps1
    .\uninstall-service.ps1 -RemoveData
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$ServiceName = 'moleculer-sidecar',
    [string]$NssmPath = (Join-Path $PSScriptRoot 'nssm.exe'),
    [string]$DataDir = (Join-Path $env:ProgramData 'moleculer-sidecar'),
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell session.'
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "service '$ServiceName' is not installed" -ForegroundColor Yellow
    return
}

if ($existing.Status -ne 'Stopped') {
    Write-Host "Stopping '$ServiceName' (graceful)..."
    Stop-Service -Name $ServiceName -Force
    (Get-Service -Name $ServiceName).WaitForStatus('Stopped', '00:00:30')
}

if (Test-Path $NssmPath) {
    & $NssmPath remove $ServiceName confirm | Out-Null
} else {
    # Fall back to the SCM if nssm.exe is gone.
    & sc.exe delete $ServiceName | Out-Null
}

Write-Host "service '$ServiceName' removed" -ForegroundColor Green

if ($RemoveData -and (Test-Path $DataDir)) {
    Write-Host "Deleting $DataDir"
    Remove-Item -Path $DataDir -Recurse -Force
}

if (-not $RemoveData) {
    Write-Host "State kept in $DataDir (pass -RemoveData to delete it)"
}
