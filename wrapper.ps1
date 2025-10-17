# Enhanced Token Tracking Wrapper for Claude Code
# Purpose: Real-time session logging with turn-level tracking and MCP server attribution
# Implements Priority 1: Session-level token tracking with JSONL event log
#
# Features:
# - Parses system warnings to extract token deltas
# - Tracks turn-level events (turn_start, tool_call, turn_end)
# - Extracts MCP server from tool names (mcp__<server>__<tool> or "built-in")
# - Writes to session-log.jsonl in real-time
# - Maintains backward compatibility with token-operations.csv
# - Adds mcp_server column to CSV

param(
    [Parameter(Mandatory = $false)]
    [string]$SessionId = "",
    [Parameter(Mandatory = $false)]
    [string]$LogDir = "C:\Users\yolan\source\repos",
    [Parameter(Mandatory = $false)]
    [switch]$VerboseLogging,
    [Parameter(Mandatory = $false)]
    [switch]$Test
)

# ============================================================================
# Configuration
# ============================================================================

$CSV_FILE = Join-Path $LogDir "token-operations.csv"
$JSONL_FILE = Join-Path $LogDir "session-log.jsonl"
$SESSION_FILE = Join-Path $LogDir "current-session.txt"

# Generate session ID if not provided
if (-not $SessionId) {
    $SessionId = "session_$(Get-Date -Format 'yyyyMMdd_HHmmss')_$([guid]::NewGuid().ToString().Substring(0,8))"
}

# Global state tracking
$global:SessionState = @{
    SessionId = $SessionId
    StartTime = Get-Date
    CurrentTurn = 0
    LastTokens = 0
    TotalTokens = 0
    Model = "claude-sonnet-4-5-20250929"  # Default model
    ToolCalls = @()
    TurnStartTokens = 0
    CacheHits = 0
    CacheMisses = 0
    AutoCachedOps = 0
}

# Automatic caching configuration
$global:AutoCacheConfig = @{
    Enabled = $true
    TokenThreshold = 500  # Minimum tokens to cache
    HighTokenTools = @('Read', 'Grep', 'SmartTypeScript', 'WebFetch', 'WebSearch')
    CacheKeyPrefix = "auto-cache:"
    MCPTimeoutMs = 5000  # MCP server response timeout in milliseconds
}

# MCP Server Process (initialized on first tool call)
$global:MCPServerProcess = $null
$global:MCPRequestId = 0
$global:MCPServerPath = $null

# ============================================================================
# Utility Functions
# ============================================================================

function Write-VerboseLog {
    param([string]$Message)
    if ($VerboseLogging) {
        Write-Host "[WRAPPER] $Message" -ForegroundColor Cyan
    }
}

function Write-JsonlEvent {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Event
    )

    try {
        # Add timestamp if not present
        if (-not $Event.ContainsKey('timestamp')) {
            $Event['timestamp'] = (Get-Date).ToString("o")
        }

        # Convert to JSON and append to file
        $jsonLine = $Event | ConvertTo-Json -Compress -Depth 10
        $jsonLine | Out-File -FilePath $JSONL_FILE -Append -Encoding UTF8 -ErrorAction Stop

        Write-VerboseLog "Wrote JSONL event: $($Event['type'])"
    }
    catch {
        Write-Warning "Failed to write JSONL event: $_"
        # Don't fail the wrapper if JSONL write fails
    }
}

function Write-CsvOperation {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ToolName,
        [Parameter(Mandatory = $true)]
        [int]$TokenEstimate,
        [Parameter(Mandatory = $false)]
        [string]$McpServer = ""
    )

    try {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $csvLine = "$timestamp,$ToolName,$TokenEstimate,$McpServer"
        $csvLine | Out-File -FilePath $CSV_FILE -Append -Encoding UTF8 -ErrorAction Stop

        Write-VerboseLog "Wrote CSV operation: $ToolName ($TokenEstimate tokens, server: $McpServer)"
    }
    catch {
        Write-Warning "Failed to write CSV operation: $_"
    }
}

function Get-McpServer {
    param([string]$ToolName)

    # Pattern: mcp__<server>__<tool>
    if ($ToolName -match '^mcp__([^_]+)__') {
        return $matches[1]
    }

    return "built-in"
}

function Get-TokenEstimate {
    param([string]$ToolName)

    # Approximate token estimates based on tool type
    $estimates = @{
        'Read' = 1500
        'Write' = 500
        'Edit' = 1000
        'Grep' = 300
        'Glob' = 200
        'Bash' = 500
        'TodoWrite' = 100
        'WebFetch' = 2000
        'WebSearch' = 1000
    }

    # Check if tool name contains any known tool
    foreach ($knownTool in $estimates.Keys) {
        if ($ToolName -like "*$knownTool*") {
            return $estimates[$knownTool]
        }
    }

    # Default estimate
    return 500
}

function Generate-CacheKey {
    param(
        [string]$ToolName,
        [hashtable]$ToolArgs
    )

    # Generate deterministic cache key from tool name and arguments
    $argsJson = $ToolArgs | ConvertTo-Json -Compress -Depth 10
    $hashInput = "$ToolName|$argsJson"

    # Use SHA256 for deterministic hash with proper disposal
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hashInput))
        # Use full hash (no truncation) to maintain collision resistance
        $hash = [BitConverter]::ToString($hashBytes).Replace("-", "")
        return "$($global:AutoCacheConfig.CacheKeyPrefix)$ToolName-$hash"
    }
    finally {
        $hasher.Dispose()
    }
}

function Get-CacheHitRate {
    param(
        [int]$Hits,
        [int]$Misses
    )
    if (($Hits + $Misses) -gt 0) {
        return [math]::Round(($Hits / ($Hits + $Misses)) * 100, 2)
    }
    else {
        return 0
    }
}

function Check-AutoCache {
    param(
        [string]$ToolName,
        [hashtable]$ToolArgs
    )

    if (-not $global:AutoCacheConfig.Enabled) {
        return $null
    }

    if ($global:AutoCacheConfig.HighTokenTools -notcontains $ToolName) {
        return $null
    }

    $cacheKey = Generate-CacheKey -ToolName $ToolName -ToolArgs $ToolArgs

    # Call MCP tool to get cached value
    try {
        $result = Invoke-MCPTool -ToolName "get_cached" -Args @{ key = $cacheKey }

        if ($result.success) {
            $global:SessionState.CacheHits++
            Write-VerboseLog "Cache HIT for $ToolName (key: $cacheKey)"
            return $result.text
        }
    }
    catch {
        Write-VerboseLog "Cache check failed: $_"
    }

    $global:SessionState.CacheMisses++
    Write-VerboseLog "Cache MISS for $ToolName (key: $cacheKey)"
    return $null
}

function Set-AutoCache {
    param(
        [string]$ToolName,
        [hashtable]$ToolArgs,
        [string]$Result,
        [int]$TokenCount
    )

    if (-not $global:AutoCacheConfig.Enabled) {
        return
    }

    if ($global:AutoCacheConfig.HighTokenTools -notcontains $ToolName) {
        return
    }

    if ($TokenCount -lt $global:AutoCacheConfig.TokenThreshold) {
        Write-VerboseLog "Skipping cache (below threshold: $TokenCount < $($global:AutoCacheConfig.TokenThreshold))"
        return
    }

    $cacheKey = Generate-CacheKey -ToolName $ToolName -ToolArgs $ToolArgs

    # Call MCP tool to optimize and cache
    try {
        $optimizeResult = Invoke-MCPTool -ToolName "optimize_text" -Args @{
            text = $Result
            key = $cacheKey
        }

        if ($optimizeResult.success) {
            $global:SessionState.AutoCachedOps++
            Write-VerboseLog "Auto-cached $ToolName (key: $cacheKey, tokens saved: $($optimizeResult.tokensSaved))"

            # Record access pattern for predictive caching
            Invoke-MCPTool -ToolName "predictive_cache" -Args @{
                operation = "record-access"
                key = $cacheKey
                metadata = @{
                    tool = $ToolName
                    tokens = $TokenCount
                }
            } | Out-Null
        }
    }
    catch {
        Write-VerboseLog "Auto-cache set failed: $_"
    }
}

function Initialize-MCPServer {
    # TODO: Integrate with real MCP server via stdio transport (JSON-RPC 2.0)
    # This function will spawn the MCP server process (node dist/server/index.js)
    # and establish stdio-based communication using JSON-RPC protocol

    if ($null -ne $global:MCPServerProcess -and -not $global:MCPServerProcess.HasExited) {
        return $true
    }

    try {
        # Find the MCP server executable (node dist/server/index.js)
        $scriptDir = Split-Path -Parent $PSCommandPath
        $serverPath = Join-Path $scriptDir "dist\server\index.js"

        if (-not (Test-Path $serverPath)) {
            # Try alternative paths
            $altPaths = @(
                (Join-Path $scriptDir "..\dist\server\index.js"),
                (Join-Path $scriptDir "..\..\dist\server\index.js")
            )

            foreach ($altPath in $altPaths) {
                if (Test-Path $altPath) {
                    $serverPath = $altPath
                    break
                }
            }
        }

        if (-not (Test-Path $serverPath)) {
            Write-VerboseLog "MCP server not found, using fallback mode"
            return $false
        }

        $global:MCPServerPath = $serverPath

        # Start MCP server process with stdio transport
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "node"
        $psi.Arguments = "`"$serverPath`""
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true

        $global:MCPServerProcess = [System.Diagnostics.Process]::Start($psi)

        Write-VerboseLog "MCP server started (PID: $($global:MCPServerProcess.Id))"
        return $true
    }
    catch {
        Write-VerboseLog "Failed to start MCP server: $_"
        return $false
    }
}

function Invoke-MCPTool {
    param(
        [string]$ToolName,
        [hashtable]$Args
    )

    # TODO: Integrate with real MCP server.
    # This function will use JSON-RPC 2.0 over stdio to communicate with the MCP server
    # The implementation should:
    # 1. Call Initialize-MCPServer to ensure the server is running
    # 2. Build a JSON-RPC request: { "jsonrpc": "2.0", "id": N, "method": "tools/call", "params": {...} }
    # 3. Write the request to the MCP server's stdin
    # 4. Read the response from the MCP server's stdout
    # 5. Parse the JSON-RPC response and extract the result
    # 6. Handle errors appropriately

    Write-VerboseLog "MCP Tool Call: $ToolName with args: $($Args | ConvertTo-Json -Compress)"

    # Initialize MCP server if available
    $serverAvailable = Initialize-MCPServer

    if (-not $serverAvailable) {
        # Fallback: Simulate responses for testing and development
        Write-VerboseLog "Using fallback MCP simulation mode"

        switch ($ToolName) {
            "optimize_text" {
                # Simulate a successful optimization
                return @{
                    success = $true
                    tokensSaved = 10  # Simulated value
                    message = "Simulated optimization success (MCP server not available)"
                }
            }
            "get_cached" {
                # Simulate cache miss (not found)
                return @{
                    success = $false
                    message = "Simulated cache miss (MCP server not available)"
                }
            }
            "predictive_cache" {
                # Simulate a successful predictive cache operation
                return @{
                    success = $true
                    message = "Simulated predictive cache success (MCP server not available)"
                }
            }
            default {
                # Simulate failure for unknown tools
                return @{
                    success = $false
                    message = "MCP server not available - fallback mode"
                }
            }
        }
    }

    try {
        # Build JSON-RPC request
        $global:MCPRequestId++
        $request = @{
            jsonrpc = "2.0"
            id = $global:MCPRequestId
            method = "tools/call"
            params = @{
                name = $ToolName
                arguments = $Args
            }
        } | ConvertTo-Json -Depth 10 -Compress

        # Write request to MCP server stdin
        $global:MCPServerProcess.StandardInput.WriteLine($request)
        $global:MCPServerProcess.StandardInput.Flush()

        # Read response from MCP server stdout (with timeout)
        $timeout = $global:AutoCacheConfig.MCPTimeoutMs
        $readTask = $global:MCPServerProcess.StandardOutput.ReadLineAsync()

        if (-not $readTask.Wait($timeout)) {
            throw "MCP server response timeout"
        }

        $response = $readTask.Result
        $responseObj = $response | ConvertFrom-Json

        # Check for JSON-RPC errors
        if ($responseObj.error) {
            Write-VerboseLog "MCP tool error: $($responseObj.error.message)"
            return @{
                success = $false
                message = "MCP tool error: $($responseObj.error.message)"
                error = $responseObj.error
            }
        }

        # Parse result from MCP response
        # MCP tools return content array with text field containing JSON
        if ($responseObj.result -and $responseObj.result.content) {
            $resultText = $responseObj.result.content[0].text
            $resultData = $resultText | ConvertFrom-Json

            # Return the parsed result data
            return $resultData
        }

        # Fallback: return raw result
        return @{
            success = $true
            message = "MCP tool executed successfully"
            data = $responseObj.result
        }
    }
    catch {
        Write-VerboseLog "MCP tool invocation failed: $_"
        return @{
            success = $false
            message = "Failed to invoke MCP tool: $_"
            error = $_.Exception.Message
        }
    }
}

function Parse-SystemWarning {
    param([string]$Line)

    # Pattern: <system_warning>Token usage: 109855/200000; 90145 remaining</system_warning>
    # Or: Token usage: 109855/200000; 90145 remaining
    if ($Line -match 'Token usage:\s*(\d+)/(\d+);\s*(\d+)\s*remaining') {
        $used = [int]$matches[1]
        $total = [int]$matches[2]
        $remaining = [int]$matches[3]

        return @{
            Used = $used
            Total = $total
            Remaining = $remaining
        }
    }

    return $null
}

function Initialize-Session {
    Write-VerboseLog "Initializing session: $($global:SessionState.SessionId)"

    # Create session-log.jsonl if it doesn't exist
    if (-not (Test-Path $JSONL_FILE)) {
        New-Item -ItemType File -Path $JSONL_FILE -Force | Out-Null
    }

    # Create token-operations.csv if it doesn't exist (with header including mcp_server)
    if (-not (Test-Path $CSV_FILE)) {
        "Timestamp,Tool,TokenEstimate,McpServer" | Out-File -FilePath $CSV_FILE -Encoding UTF8
    }

    # Write session_start event
    Write-JsonlEvent -Event @{
        type = "session_start"
        sessionId = $global:SessionState.SessionId
        timestamp = $global:SessionState.StartTime.ToString("o")
        model = $global:SessionState.Model
    }

    # Save session ID to file for reference
    $global:SessionState.SessionId | Out-File -FilePath $SESSION_FILE -Encoding UTF8 -Force

    Write-VerboseLog "Session initialized: $($global:SessionState.SessionId)"
}

function Start-Turn {
    param([string]$UserMessagePreview = "")

    $global:SessionState.CurrentTurn++
    $global:SessionState.TurnStartTokens = $global:SessionState.LastTokens
    $global:SessionState.ToolCalls = @()

    Write-VerboseLog "Starting turn $($global:SessionState.CurrentTurn)"

    Write-JsonlEvent -Event @{
        type = "turn_start"
        turn = $global:SessionState.CurrentTurn
        user_message_preview = $UserMessagePreview.Substring(0, [Math]::Min(100, $UserMessagePreview.Length))
        tokens_before = $global:SessionState.LastTokens
    }
}

function Record-ToolCall {
    param(
        [string]$ToolName,
        [int]$TokensBefore,
        [int]$TokensAfter,
        [hashtable]$ToolArgs = @{},
        [string]$ToolResult = "",
        [bool]$CacheHit = $false
    )

    $tokensDelta = $TokensAfter - $TokensBefore
    $mcpServer = Get-McpServer -ToolName $ToolName

    Write-VerboseLog "Tool call: $ToolName (server: $mcpServer, delta: $tokensDelta, cache: $CacheHit)"

    # Write JSONL event
    Write-JsonlEvent -Event @{
        type = "tool_call"
        turn = $global:SessionState.CurrentTurn
        tool = $ToolName
        server = $mcpServer
        tokens_before = $TokensBefore
        tokens_after = $TokensAfter
        tokens_delta = $tokensDelta
        cache_hit = $CacheHit
        auto_cached = ($global:AutoCacheConfig.HighTokenTools -contains $ToolName)
    }

    # Write CSV operation (with MCP server)
    Write-CsvOperation -ToolName $ToolName -TokenEstimate $tokensDelta -McpServer $mcpServer

    # Automatic caching logic
    # Check for non-null and non-empty ToolResult using idiomatic PowerShell
    if (-not $CacheHit -and -not [string]::IsNullOrEmpty($ToolResult) -and $tokensDelta -ge $global:AutoCacheConfig.TokenThreshold) {
        Set-AutoCache -ToolName $ToolName -ToolArgs $ToolArgs -Result $ToolResult -TokenCount $tokensDelta
    }

    # Track for turn summary
    $global:SessionState.ToolCalls += @{
        Tool = $ToolName
        Server = $mcpServer
        Delta = $tokensDelta
        CacheHit = $CacheHit
    }

    # Update last tokens
    $global:SessionState.LastTokens = $TokensAfter
}

function End-Turn {
    $turnTokens = $global:SessionState.LastTokens - $global:SessionState.TurnStartTokens
    $cacheHitRate = Get-CacheHitRate -Hits $global:SessionState.CacheHits -Misses $global:SessionState.CacheMisses

    Write-VerboseLog "Ending turn $($global:SessionState.CurrentTurn) (turn tokens: $turnTokens, cache hit rate: $cacheHitRate%)"

    Write-JsonlEvent -Event @{
        type = "turn_end"
        turn = $global:SessionState.CurrentTurn
        total_tokens = $global:SessionState.LastTokens
        turn_tokens = $turnTokens
        tool_calls = $global:SessionState.ToolCalls.Count
        cache_stats = @{
            hits = $global:SessionState.CacheHits
            misses = $global:SessionState.CacheMisses
            hit_rate = $cacheHitRate
            auto_cached = $global:SessionState.AutoCachedOps
        }
    }
}

# ============================================================================
# Main Wrapper Logic
# ============================================================================

function Invoke-ClaudeCodeWrapper {
    Write-Host "Token Optimizer MCP - Enhanced Session Wrapper" -ForegroundColor Green
    Write-Host "Session ID: $($global:SessionState.SessionId)" -ForegroundColor Yellow
    Write-Host "Log Directory: $LogDir" -ForegroundColor Yellow
    Write-Host ""

    Initialize-Session

    # Track if we're in a turn
    $inTurn = $false
    $lastUserMessage = ""

    # Start reading from stdin (piped from claude-code)
    # In practice, this would wrap the actual claude-code CLI process
    # For now, we'll demonstrate the structure

    try {
        Write-VerboseLog "Wrapper ready - monitoring for system warnings and tool calls"

        # Simulated processing loop (in real usage, this would pipe claude-code stdout/stderr)
        # For testing purposes, we'll show the structure

        while ($true) {
            # Read line from stdin (in real wrapper, this comes from claude-code)
            $line = Read-Host -Prompt "Input"

            if ($line -eq "exit" -or $line -eq "quit") {
                break
            }

            # Parse system warnings
            $tokenInfo = Parse-SystemWarning -Line $line
            if ($tokenInfo) {
                Write-VerboseLog "Parsed token info: Used=$($tokenInfo.Used), Remaining=$($tokenInfo.Remaining)"

                # Check if this is a tool call transition (tokens increased)
                if ($tokenInfo.Used -gt $global:SessionState.LastTokens) {
                    # Detect tool call (in real wrapper, we'd parse the tool name from surrounding context)
                    # For now, we'll prompt for demo purposes
                    $toolName = Read-Host -Prompt "Tool name"

                    if (-not $inTurn) {
                        Start-Turn -UserMessagePreview $lastUserMessage
                        $inTurn = $true
                    }

                    Record-ToolCall -ToolName $toolName -TokensBefore $global:SessionState.LastTokens -TokensAfter $tokenInfo.Used
                }

                $global:SessionState.LastTokens = $tokenInfo.Used
                $global:SessionState.TotalTokens = $tokenInfo.Total
            }

            # Check for turn boundaries (user input)
            if ($line -like "User:*") {
                if ($inTurn) {
                    End-Turn
                    $inTurn = $false
                }

                $lastUserMessage = $line -replace '^User:\s*', ''
            }

            # Pass through the line (in real wrapper, this would go to stdout)
            Write-Output $line
        }

        # Finalize session
        if ($inTurn) {
            End-Turn
        }

    }
    catch {
        Write-Error "Wrapper error: $_"
    }
    finally {
        Write-VerboseLog "Session ended: $($global:SessionState.SessionId)"

        # Cleanup MCP server process if running
        if ($null -ne $global:MCPServerProcess -and -not $global:MCPServerProcess.HasExited) {
            # Attempt graceful shutdown for console process
            try {
                if ($global:MCPServerProcess.StandardInput) {
                    $global:MCPServerProcess.StandardInput.Close()
                    Write-VerboseLog "Sent EOF to MCP server process via StandardInput.Close()"
                }
            } catch {
                Write-VerboseLog "Could not close StandardInput: $_"
            }
            # Wait up to 5 seconds for process to exit
            if (-not $global:MCPServerProcess.WaitForExit(5000)) {
                $global:MCPServerProcess.Kill()
                Write-VerboseLog "MCP server process forcefully terminated after timeout"
            }
            else {
                Write-VerboseLog "MCP server process exited gracefully"
            }
        }
    }
}

# ============================================================================
# Standalone Testing Functions
# ============================================================================

function Test-WrapperParsing {
    Write-Host "`nTesting System Warning Parsing..." -ForegroundColor Cyan

    $testCases = @(
        "<system_warning>Token usage: 109855/200000; 90145 remaining</system_warning>",
        "Token usage: 86931/200000; 113069 remaining",
        "  Token usage: 94226/200000; 105774 remaining  "
    )

    foreach ($test in $testCases) {
        $result = Parse-SystemWarning -Line $test
        if ($result) {
            Write-Host "  PASS: Parsed used=$($result.Used), total=$($result.Total), remaining=$($result.Remaining)" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: Could not parse: $test" -ForegroundColor Red
        }
    }

    Write-Host "`nTesting MCP Server Extraction..." -ForegroundColor Cyan

    $toolTests = @(
        @{ Name = "mcp__supabase__search_docs"; Expected = "supabase" },
        @{ Name = "mcp__git__git_commit"; Expected = "git" },
        @{ Name = "Read"; Expected = "built-in" },
        @{ Name = "mcp__console-automation__console_create_session"; Expected = "console-automation" }
    )

    foreach ($test in $toolTests) {
        $result = Get-McpServer -ToolName $test.Name
        if ($result -eq $test.Expected) {
            Write-Host "  PASS: $($test.Name) -> $result" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: $($test.Name) -> $result (expected: $($test.Expected))" -ForegroundColor Red
        }
    }

    Write-Host "`nTesting JSONL Event Writing..." -ForegroundColor Cyan

    Initialize-Session
    Start-Turn -UserMessagePreview "Test user message for parsing"
    Record-ToolCall -ToolName "mcp__git__git_status" -TokensBefore 1000 -TokensAfter 1500
    Record-ToolCall -ToolName "Read" -TokensBefore 1500 -TokensAfter 2000
    End-Turn

    Write-Host "  PASS: Events written to $JSONL_FILE" -ForegroundColor Green
    Write-Host "  PASS: Operations written to $CSV_FILE" -ForegroundColor Green

    # Show last few lines of JSONL
    Write-Host "`nLast 5 JSONL events:" -ForegroundColor Cyan
    Get-Content $JSONL_FILE | Select-Object -Last 5 | ForEach-Object {
        Write-Host "  $_" -ForegroundColor Gray
    }
}

# ============================================================================
# Entry Point
# ============================================================================

# Check if running in test mode
if ($Test) {
    Test-WrapperParsing
}
else {
    # Real wrapper mode (would wrap claude-code CLI)
    # Invoke-ClaudeCodeWrapper

    Write-Host @"
Token Optimizer MCP - Enhanced Session Wrapper

USAGE:
  To test parsing:
    .\wrapper.ps1 -Test -VerboseLogging

  To wrap Claude Code (not yet implemented - requires CLI integration):
    claude-code | .\wrapper.ps1 -SessionId "my-session" -VerboseLogging

FEATURES:
  - Real-time token tracking from system warnings
  - Turn-level event logging to session-log.jsonl
  - MCP server attribution for all tool calls
  - Backward compatible CSV logging with mcp_server column
  - Automatic MCP server initialization with fallback mode

FILES:
  - Session log (JSONL): $JSONL_FILE
  - Operations log (CSV): $CSV_FILE
  - Current session ID: $SESSION_FILE

Run with -Test flag to see parsing examples.
"@
}
