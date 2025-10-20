# Token Optimizer MCP - Direct CLI Invocation via stdin
# Production-ready PowerShell helper using Gemini-recommended stdin approach
# This completely avoids all JSON escaping issues

param(
    [Parameter(Mandatory=$true)]
    [string]$Tool,

    [Parameter(Mandatory=$true)]
    [hashtable]$Arguments
)

$LOG_FILE = "C:\Users\cheat\.claude-global\hooks\logs\token-optimizer-calls.log"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$CLI_WRAPPER = Join-Path $repoRoot "cli-wrapper.mjs"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try {
        "[$timestamp] [$Level] $Message" | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Silently fail
    }
}

try {
    # Validate CLI wrapper exists
    if (-not (Test-Path $CLI_WRAPPER)) {
        Write-Log "CLI wrapper not found at: $CLI_WRAPPER" "ERROR"
        return $null
    }

    # Convert arguments to JSON
    $argsJson = $Arguments | ConvertTo-Json -Compress -Depth 10

    Write-Log "Calling tool: $Tool via stdin" "DEBUG"
    Write-Log "Arguments: $argsJson" "DEBUG"

    # Pipe JSON to stdin - this avoids ALL escaping issues!
    $result = $argsJson | node $CLI_WRAPPER $Tool --stdin 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Log "Tool call failed with exit code $LASTEXITCODE" "ERROR"
        Write-Log "Output: $result" "ERROR"
        return $null
    }

    # Parse JSON result
    try {
        $parsed = $result | ConvertFrom-Json
        Write-Log "Tool call succeeded" "DEBUG"
        return $parsed
    } catch {
        Write-Log "Failed to parse result as JSON: $result" "ERROR"
        return $null
    }

} catch {
    Write-Log "Fatal error: $($_.Exception.Message)" "ERROR"
    return $null
}
