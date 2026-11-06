# Neo MD desktop benchmark collector (PowerShell).
#
# NOTE: This file is ASCII-only ON PURPOSE.
# Windows PowerShell 5.1 reads a .ps1 file WITHOUT a BOM as ANSI/GBK, which
# corrupts any non-ASCII characters (e.g. Chinese comments) and produces bogus
# parse errors such as "Missing statement block in switch statement clause".
# Rule for this repo:
#   .ps1  -> ASCII only, or UTF-8 WITH BOM
#   .json -> UTF-8 WITHOUT BOM (serde_json / JSON.parse reject a BOM)
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#     -File bench-collect.ps1 -Action <action> -ProcName <name> [-TimeoutSec N]
#
# Output is a single line of plain text (pipe separated) parsed by node.

param(
    [Parameter(Mandatory = $true)]
    [string]$Action,

    [string]$ProcName = '',
    [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-TargetProcesses {
    param([string]$Name)
    return @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
}

switch ($Action) {

    # Wait until a process with a real main window handle appears.
    'wait-window' {
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline) {
            $p = Get-TargetProcesses $ProcName |
                 Where-Object { $_.MainWindowHandle -ne 0 } |
                 Select-Object -First 1
            if ($p) {
                Write-Output "OK"
                exit 0
            }
            Start-Sleep -Milliseconds 100
        }
        Write-Output "TIMEOUT"
        exit 0
    }

    # Is any process with this name alive?
    'alive' {
        $ps = Get-TargetProcesses $ProcName
        if ($ps.Count -gt 0) { Write-Output "1" } else { Write-Output "0" }
        exit 0
    }

    # One sample: sum(WorkingSet64) | sum(CPU seconds) | process count
    'sample' {
        $ps = Get-TargetProcesses $ProcName
        if ($ps.Count -eq 0) {
            Write-Output "DEAD"
            exit 0
        }
        $ws  = ($ps | Measure-Object -Property WorkingSet64 -Sum).Sum
        $cpu = ($ps | Measure-Object -Property CPU -Sum).Sum
        $n   = $ps.Count
        if (-not $ws)  { $ws = 0 }
        if (-not $cpu) { $cpu = 0 }
        $ws  = [math]::Round([double]$ws)
        $cpu = [math]::Round([double]$cpu, 3)
        Write-Output "$ws|$cpu|$n"
        exit 0
    }

    # Kill every process with this name.
    'kill' {
        Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
        Write-Output "KILLED"
        exit 0
    }

    # Logical processor count.
    'cores' {
        Write-Output $env:NUMBER_OF_PROCESSORS
        exit 0
    }

    # OS caption | total physical memory | logical cpus | version
    'sysinfo' {
        $os = Get-CimInstance Win32_OperatingSystem
        $cs = Get-CimInstance Win32_ComputerSystem
        Write-Output "$($os.Caption)|$($cs.TotalPhysicalMemory)|$($cs.NumberOfLogicalProcessors)|$($os.Version)"
        exit 0
    }

    default {
        Write-Output "UNKNOWN_ACTION:$Action"
        exit 1
    }
}
