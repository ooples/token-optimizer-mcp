# MCP Invocation Helper
# Provides unified interface for calling token-optimizer-mcp tools
# Works with Claude Code's connected MCP servers

param(
    [Parameter(Mandatory=$true)]
    [string]$Tool,

    [Parameter(Mandatory=$false)]
    [string]$ArgumentsJson = "{}",

    [Parameter(Mandatory=$false)]
    [string]$ServerName = "token-optimizer"
)

$LOG_FILE = "C:\Users\cheat\.claude-global\hooks\logs\mcp-invocation.log"

# Convert PSCustomObject to Hashtable recursively
# This function must be defined before use
function ConvertTo-Hashtable {
    param([Parameter(ValueFromPipeline)]$InputObject)

    if ($null -eq $InputObject) { return $null }

    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        $collection = @()
        foreach ($item in $InputObject) {
            $collection += ConvertTo-Hashtable $item
        }
        return $collection
    }

    if ($InputObject -is [psobject]) {
        $hash = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $hash[$property.Name] = ConvertTo-Hashtable $property.Value
        }
        return $hash
    }

    return $InputObject
}

# Convert JSON string to hashtable
# Note: -AsHashtable parameter fails in some PowerShell versions
# Manual conversion ensures compatibility
try {
    $jsonObj = $ArgumentsJson | ConvertFrom-Json
    $Arguments = ConvertTo-Hashtable $jsonObj
    if ($null -eq $Arguments) {
        $Arguments = @{}
    }
} catch {
    # Silently fall back to empty hashtable
    $Arguments = @{}
}

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    try {
        $logEntry | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Silently fail
    }
}

function Invoke-MCP {
    param(
        [string]$Server,
        [string]$Tool,
        $ToolArguments  # FIXED: Renamed from $Args to avoid collision with PowerShell's automatic $args variable
    )

    try {
        Write-Log "Invoking MCP: $Server -> $Tool" "DEBUG"

        # Ensure ToolArguments is a proper object for JSON serialization
        if ($null -eq $ToolArguments) {
            $ToolArguments = @{}
        }

        # Build MCP protocol request
        # PowerShell Hashtables serialize correctly to JSON objects without casting
        # No [PSCustomObject] conversion needed - let ConvertTo-Json handle it natively
        $jsonArguments = $ToolArguments

        $request = @{
            jsonrpc = "2.0"
            id = [guid]::NewGuid().ToString()
            method = "tools/call"
            params = @{
                name = $Tool
                arguments = $jsonArguments
            }
        } | ConvertTo-Json -Depth 10 -Compress

        Write-Log "Request: $request" "DEBUG"

        # Invoke via npx (Claude Code connects via stdio)
        $env:TOKEN_OPTIMIZER_CACHE_DIR = "$env:USERPROFILE\.token-optimizer-cache"

        $result = $request | cmd /c npx -y token-optimizer-mcp@latest 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Log "MCP call failed with exit code $LASTEXITCODE" "ERROR"
            Write-Log "Output: $result" "ERROR"
            return $null
        }

        Write-Log "Result: $result" "DEBUG"

        # Parse JSON response
        try {
            $response = $result | ConvertFrom-Json

            if ($response.error) {
                Write-Log "MCP error: $($response.error.message)" "ERROR"
                return $null
            }

            return $response.result
        } catch {
            Write-Log "Failed to parse MCP response: $($_.Exception.Message)" "ERROR"
            Write-Log "Raw response: $result" "ERROR"
            return $null
        }

    } catch {
        Write-Log "MCP invocation failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

# Debug logging
Write-Log "Arguments type: $($Arguments.GetType().FullName)" "DEBUG"
Write-Log "Arguments content: $($Arguments | ConvertTo-Json -Compress)" "DEBUG"

# Execute the MCP call
$result = Invoke-MCP -Server $ServerName -Tool $Tool -ToolArguments $Arguments

# Output result as JSON for caller
if ($result) {
    $result | ConvertTo-Json -Depth 10 -Compress
} else {
    Write-Log "MCP call returned no result" "WARN"
    @{ success = $false } | ConvertTo-Json
}
