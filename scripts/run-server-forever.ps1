$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
$logDir = Join-Path $root "tmp\service-logs"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$serverEntry = Join-Path $root "src\server\index.js"
$logFile = Join-Path $logDir "server.log"

function Stop-ProcessTree {
  param(
    [int]$ProcessId
  )

  if (-not $ProcessId -or $ProcessId -eq $PID) {
    return
  }

  $children = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId })
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }

  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-ExistingProjectProcesses {
  $escapedRoot = [Regex]::Escape([string]$root)
  $listenerPids = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($listenerPid in $listenerPids) {
    Stop-ProcessTree -ProcessId ([int]$listenerPid)
  }

  $projectProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $line = [string]$_.CommandLine
    if (-not $line) {
      return $false
    }

    $isServerNode = $_.Name -eq "node.exe" -and $line -match $escapedRoot -and $line -like "*src/server/index.js*"
    $isRunnerCmd = $_.Name -eq "cmd.exe" -and $line -match $escapedRoot -and $line -like "*run-server-forever.cmd*"
    $isRunnerPs = $_.Name -eq "powershell.exe" -and $_.ProcessId -ne $PID -and $line -match $escapedRoot -and (
      $line -like "*run-server-forever.ps1*" -or
      $line -like "*run-server-forever.cmd*"
    )
    $isRunnerVbs = $_.Name -eq "wscript.exe" -and $line -match $escapedRoot -and $line -like "*run-server-forever.vbs*"
    $isOcrWorker = $_.Name -eq "python.exe" -and $line -match $escapedRoot -and $line -like "*scripts/local_ocr_worker.py*"

    $isServerNode -or $isRunnerCmd -or $isRunnerPs -or $isRunnerVbs -or $isOcrWorker
  })

  foreach ($process in $projectProcesses) {
    Stop-ProcessTree -ProcessId ([int]$process.ProcessId)
  }
}

if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

Set-Location $root

while ($true) {
  Stop-ExistingProjectProcesses
  Add-Content -Path $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] starting server"
  & $nodeExe $serverEntry 1>> $logFile 2>&1
  $exitCode = $LASTEXITCODE
  Add-Content -Path $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] server exited with code $exitCode, restarting in 5 seconds"
  Start-Sleep -Seconds 5
}
