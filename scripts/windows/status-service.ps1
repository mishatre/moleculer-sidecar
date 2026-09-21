<#
.SYNOPSIS
    Shows the moleculer-sidecar service state, its NSSM configuration and the
    tail of its logs.
#>
[CmdletBinding()]
param(
    [string]$ServiceName = 'moleculer-sidecar',
    [string]$NssmPath = (Join-Path $PSScriptRoot 'nssm.exe'),
    [int]$Tail = 15
)

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "service '$ServiceName' is not installed" -ForegroundColor Yellow
    return
}

$service | Format-List Name, DisplayName, Status, StartType

if (Test-Path $NssmPath) {
    foreach ($key in @('Application', 'AppParameters', 'AppDirectory', 'AppEnvironmentExtra')) {
        $value = (& $NssmPath get $ServiceName $key 2>$null) -join ' '
        Write-Host ("{0,-22} {1}" -f $key, $value)
    }
}

$dataDir = (& $NssmPath get $ServiceName AppDirectory 2>$null) -join ' '
if (-not $dataDir) { $dataDir = Join-Path $env:ProgramData 'moleculer-sidecar' }
$logDir = Join-Path $dataDir 'logs'

foreach ($name in @("$ServiceName.err.log", "$ServiceName.out.log")) {
    $file = Join-Path $logDir $name
    if (Test-Path $file) {
        Write-Host ''
        Write-Host "--- $file (last $Tail lines) ---"
        Get-Content -Path $file -Tail $Tail
    }
}
