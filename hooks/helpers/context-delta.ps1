[CmdletBinding()]
param()

<#
PowerShell integration for the context_delta MCP tool — addresses
issue #122 Phase 2.

Get-TokenOptimizerSessionId generates a stable sessionId per top-level
PS session (cached on the script scope and persisted to a marker file
so multiple orchestrator invocations within one Claude session reuse
the same id).

Invoke-ContextDelta calls the context_delta MCP tool via the shared
Invoke-TokenOptimizer helper and returns the unified-diff delta so
Handle-SmartRead can emit only the changed lines to the model.
#>

$script:TokenOptimizerSessionIdPath =
    Join-Path $env:USERPROFILE '.token-optimizer\current-session-id'

function Get-TokenOptimizerSessionId {
    if ($script:TokenOptimizerCurrentSessionId) {
        return $script:TokenOptimizerCurrentSessionId
    }
    if (Test-Path $script:TokenOptimizerSessionIdPath) {
        $existing = (Get-Content -Path $script:TokenOptimizerSessionIdPath -Raw).Trim()
        if ($existing) {
            $script:TokenOptimizerCurrentSessionId = $existing
            return $existing
        }
    }
    $newId = [guid]::NewGuid().ToString()
    $dir = Split-Path -Parent $script:TokenOptimizerSessionIdPath
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Set-Content -Path $script:TokenOptimizerSessionIdPath -Value $newId
    $script:TokenOptimizerCurrentSessionId = $newId
    return $newId
}

function Reset-TokenOptimizerSessionId {
    $script:TokenOptimizerCurrentSessionId = $null
    if (Test-Path $script:TokenOptimizerSessionIdPath) {
        Remove-Item -Path $script:TokenOptimizerSessionIdPath -Force
    }
}

function Invoke-ContextDelta {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('compute-delta', 'seed', 'clear')]
        [string]$Operation,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string]$CurrentContent = $null,
        [string]$SessionId = $null
    )

    if (-not $SessionId) {
        $SessionId = Get-TokenOptimizerSessionId
    }
    $toolArgs = @{
        operation = $Operation
        sessionId = $SessionId
        filePath = $FilePath
    }
    if ($Operation -ne 'clear' -and $null -ne $CurrentContent) {
        $toolArgs.currentContent = $CurrentContent
    }

    # Call the MCP tool via the repo's existing invoke-mcp.ps1 script.
    # The server-side ContextDeltaTool auto-creates the session on first
    # contact, so there's no separate bootstrap step needed here.
    $invokeMcp = Join-Path $PSScriptRoot 'invoke-mcp.ps1'
    if (-not (Test-Path $invokeMcp)) {
        if (Get-Command Write-Log -ErrorAction SilentlyContinue) {
            Write-Log "invoke-mcp.ps1 not found at $invokeMcp; skipping context_delta." 'DEBUG'
        }
        return $null
    }

    try {
        $argsJson = $toolArgs | ConvertTo-Json -Compress
        $resultJson = & $invokeMcp -Tool 'context_delta' -ArgumentsJson $argsJson
        if ($resultJson) {
            return ($resultJson | ConvertFrom-Json)
        }
        return $null
    } catch {
        $msg = "Invoke-ContextDelta failed: $($_.Exception.Message)"
        if (Get-Command Write-Log -ErrorAction SilentlyContinue) {
            Write-Log $msg 'WARN'
        } else {
            Write-Warning $msg
        }
        return $null
    }
}
