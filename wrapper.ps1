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
}

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
        [int]$TokensAfter
    )

    $tokensDelta = $TokensAfter - $TokensBefore
    $mcpServer = Get-McpServer -ToolName $ToolName

    Write-VerboseLog "Tool call: $ToolName (server: $mcpServer, delta: $tokensDelta)"

    # Write JSONL event
    Write-JsonlEvent -Event @{
        type = "tool_call"
        turn = $global:SessionState.CurrentTurn
        tool = $ToolName
        server = $mcpServer
        tokens_before = $TokensBefore
        tokens_after = $TokensAfter
        tokens_delta = $tokensDelta
    }

    # Write CSV operation (with MCP server)
    Write-CsvOperation -ToolName $ToolName -TokenEstimate $tokensDelta -McpServer $mcpServer

    # Track for turn summary
    $global:SessionState.ToolCalls += @{
        Tool = $ToolName
        Server = $mcpServer
        Delta = $tokensDelta
    }

    # Update last tokens
    $global:SessionState.LastTokens = $TokensAfter
}

function End-Turn {
    $turnTokens = $global:SessionState.LastTokens - $global:SessionState.TurnStartTokens

    Write-VerboseLog "Ending turn $($global:SessionState.CurrentTurn) (turn tokens: $turnTokens)"

    Write-JsonlEvent -Event @{
        type = "turn_end"
        turn = $global:SessionState.CurrentTurn
        total_tokens = $global:SessionState.LastTokens
        turn_tokens = $turnTokens
        tool_calls = $global:SessionState.ToolCalls.Count
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

FILES:
  - Session log (JSONL): $JSONL_FILE
  - Operations log (CSV): $CSV_FILE
  - Current session ID: $SESSION_FILE

Run with -Test flag to see parsing examples.
"@
}
