$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
$logDir = Join-Path $root "tmp\service-logs"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$serverEntry = Join-Path $root "src\server\index.js"
$logFile = Join-Path $logDir "server.log"

if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

Set-Location $root

while ($true) {
  Add-Content -Path $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] starting server"
  & $nodeExe $serverEntry 1>> $logFile 2>&1
  $exitCode = $LASTEXITCODE
  Add-Content -Path $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] server exited with code $exitCode, restarting in 5 seconds"
  Start-Sleep -Seconds 5
}
