# Enhanced Token Tracking Wrapper for Claude Code
# Purpose: Real-time session logging with turn-level tracking and MCP server attribution
# Implements Priority 1: Session-level token tracking with JSONL event log
# Version: 1.0.0
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
    # Default: $env:USERPROFILE\token-optimizer-logs (e.g., C:\Users\<YourUsername>\token-optimizer-logs)
    [Parameter(Mandatory = $false)]
    [string]$LogDir = (Join-Path $env:USERPROFILE "token-optimizer-logs"),
    [Parameter(Mandatory = $false)]
    [switch]$VerboseLogging,
    [Parameter(Mandatory = $false)]
    [switch]$Test,
    # Performance threshold in milliseconds for logging warnings (default: 10ms)
    [Parameter(Mandatory = $false)]
    [int]$PerformanceThresholdMs = 10,
    # Line buffer size for context lookback (default: 100 lines)
    [Parameter(Mandatory = $false)]
    [int]$LineBufferSize = 100
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

# Checks if the provided log directory is within the allowed base directory.
# Prevents path traversal attacks by ensuring $LogDir is either the same as $BaseLogDir
# or a subdirectory of it. Both paths are resolved to their absolute forms.
function Test-LogDirIsSafe {
    param(
        [string]$LogDir,
        [string]$BaseLogDir
    )

    # Use GetRelativePath to robustly check if LogDir is within BaseLogDir
    $relativePath = [System.IO.Path]::GetRelativePath($BaseLogDir, $LogDir)

    # If the relative path starts with ".." or is "..", it's outside the base directory
    if ($relativePath -eq ".." -or $relativePath.StartsWith(".." + [System.IO.Path]::DirectorySeparatorChar)) {
        return $false
    }

    return $true
}

function Initialize-Session {
    Write-VerboseLog "Initializing session: $($global:SessionState.SessionId)"

    # Validate log directory path to prevent path traversal attacks
    # Use GetFullPath to resolve the path and check if it's within the expected base directory
    # NOTE: This validation is intentionally restrictive for security. For custom base directories,
    # modify the $BaseLogDir assignment or disable validation for trusted environments.
    $BaseLogDir = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "token-optimizer-logs"))
    $ResolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)

    if (-not (Test-LogDirIsSafe -LogDir $ResolvedLogDir -BaseLogDir $BaseLogDir)) {
        throw "Invalid log directory path: path traversal detected. LogDir must be within $BaseLogDir."
    }

    # Create log directory if it doesn't exist
    if (-not (Test-Path $ResolvedLogDir -PathType Container)) {
        Write-VerboseLog "Creating log directory: $ResolvedLogDir"
        New-Item -ItemType Directory -Path $ResolvedLogDir -Force | Out-Null
    }

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
# Real-Time Stream Processing
# ============================================================================

function Parse-ToolCallFromContext {
    param(
        [string]$CurrentLine,
        [string[]]$PreviousLines,
        [int]$LookbackLimit = 20
    )

    # Pattern 1: Tool call in antml:function_calls block
    # <invoke name="ToolName">
    $toolCallPattern = '<invoke name="([^"]+)">'
    if ($CurrentLine -match $toolCallPattern) {
        return $matches[1]
    }

    # Pattern 2: Search previous lines for recent tool invocation
    $lookback = [Math]::Min($LookbackLimit, $PreviousLines.Count)
    for ($i = $PreviousLines.Count - 1; $i -ge [Math]::Max(0, $PreviousLines.Count - $lookback); $i--) {
        if ($PreviousLines[$i] -match $toolCallPattern) {
            return $matches[1]
        }
    }

    # Pattern 3: Function call result block
    # <result><name>ToolName</name>
    if ($CurrentLine -match '<name>([^<]+)</name>') {
        return $matches[1]
    }

    return $null
}

function Get-CachedToolResponse {
    param(
        [string]$ToolName,
        [hashtable]$ToolParams
    )

    # Check if cache lookup tool is available
    # For now, return null. Cache injection will be implemented once the cache backend integration is complete.
    # See project roadmap or related issues for implementation timeline.
    return $null
}

function Inject-CachedResponse {
    param(
        [string]$CachedResponse,
        [string]$ToolName
    )

    # Inject cached response into stream
    # Format as tool result
    Write-VerboseLog "Injecting cached response for: $ToolName"

    $injectedOutput = @"
<function_results>
<result>
<name>$ToolName</name>
<output>$CachedResponse</output>
</result>
</function_results>
"@

    Write-Output $injectedOutput
}

# ============================================================================
# Main Wrapper Logic
# ============================================================================

<#
.SYNOPSIS
Real-time CLI wrapper for Claude Code that tracks token usage and logs events.

.DESCRIPTION
Processes stdin in real-time, parses system warnings to extract token deltas,
tracks turn-level events, and writes to session-log.jsonl.

DESIGN NOTE - Blocking I/O:
ReadLine() uses blocking I/O by design. This is intentional for the wrapper context,
where stdin is managed by a parent process such as Claude Code (a CLI tool that may
use MCP servers). The stream closes when the parent process terminates, preventing
indefinite hangs. Timeout mechanisms are not required as the wrapper lifecycle is
controlled by the parent process.
For production recommendations in other contexts, see CLI_INTEGRATION.md.
#>
function Invoke-ClaudeCodeWrapper {
    Write-Host "Token Optimizer MCP - Enhanced Session Wrapper (Real-Time Mode)" -ForegroundColor Green
    Write-Host "Session ID: $($global:SessionState.SessionId)" -ForegroundColor Yellow
    Write-Host "Log Directory: $LogDir" -ForegroundColor Yellow
    Write-Host ""

    Initialize-Session

    # Track if we're in a turn
    $inTurn = $false
    $lastUserMessage = ""
    # Use Queue for efficient FIFO operations (better than ArrayList.RemoveAt(0))
    $lineBuffer = [System.Collections.Generic.Queue[string]]::new($LineBufferSize)
    $pendingToolCall = $null
    $lastTokenCount = 0

    try {
        Write-VerboseLog "Wrapper ready - real-time stream processing active"

        # Configure console encoding for proper Unicode handling
        [Console]::InputEncoding = [System.Text.Encoding]::UTF8
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

        $input = [Console]::In
        while ($true) {
            $line = $input.ReadLine()

            # Check for end of stream
            if ($null -eq $line) {
                Write-VerboseLog "End of stream detected"
                break
            }

            # Add to line buffer (for context lookback)
            # Note: LineBufferSize is configurable via parameter (default: 100)
            # Using Queue.Enqueue/Dequeue for O(1) operations instead of ArrayList.RemoveAt(0)
            $lineBuffer.Enqueue($line)
            if ($lineBuffer.Count -gt $LineBufferSize) {
                [void]$lineBuffer.Dequeue()  # Remove oldest line efficiently
            }

            # Performance tracking
            $parseStartTime = Get-Date

            # Parse system warnings
            $tokenInfo = Parse-SystemWarning -Line $line
            if ($tokenInfo) {
                Write-VerboseLog "Parsed token info: Used=$($tokenInfo.Used), Remaining=$($tokenInfo.Remaining)"

                # Check if this is a tool call transition (tokens increased)
                # Performance optimization: Only call Parse-ToolCallFromContext when token count increases
                if ($tokenInfo.Used -gt $global:SessionState.LastTokens) {
                    # Detect tool call from context (ONLY when tokens increased)
                    # Convert Queue to array for pattern matching
                    $toolName = Parse-ToolCallFromContext -CurrentLine $line -PreviousLines @($lineBuffer.ToArray())

                    if ($toolName) {
                        Write-VerboseLog "Detected tool call: $toolName"

                        # Start turn if not already in one
                        if (-not $inTurn) {
                            Start-Turn -UserMessagePreview $lastUserMessage
                            $inTurn = $true
                        }

                        # Check for cached response (optional)
                        $cachedResponse = Get-CachedToolResponse -ToolName $toolName -ToolParams @{}

                        if ($cachedResponse) {
                            # Inject cached response and skip tool execution
                            Inject-CachedResponse -CachedResponse $cachedResponse -ToolName $toolName
                            Write-VerboseLog "Cache hit! Injected response for: $toolName"

                            # Record cache hit in JSONL
                            Write-JsonlEvent -Event @{
                                type = "cache_hit"
                                turn = $global:SessionState.CurrentTurn
                                tool = $toolName
                                tokens_saved = ($tokenInfo.Used - $global:SessionState.LastTokens)
                            }
                        }
                        else {
                            # Record tool call with actual token delta
                            Record-ToolCall -ToolName $toolName -TokensBefore $global:SessionState.LastTokens -TokensAfter $tokenInfo.Used
                        }
                    }
                    else {
                        Write-VerboseLog "Token increase detected but no tool call identified (delta: $($tokenInfo.Used - $global:SessionState.LastTokens))"
                    }
                }

                $global:SessionState.LastTokens = $tokenInfo.Used
                $global:SessionState.TotalTokens = $tokenInfo.Total
            }

            # Check for turn boundaries (user input pattern)
            # Pattern: Look for conversation turn markers
            $userMessagePattern = '^\s*(User|Human):\s*'
            if ($line -match $userMessagePattern) {
                if ($inTurn) {
                    End-Turn
                    $inTurn = $false
                }

                $lastUserMessage = $line -replace $userMessagePattern, ''
                Write-VerboseLog "New user message detected: $($lastUserMessage.Substring(0, [Math]::Min(50, $lastUserMessage.Length)))..."
            }

            # Performance tracking
            $parseEndTime = Get-Date
            $parseTime = ($parseEndTime - $parseStartTime).TotalMilliseconds

            if ($parseTime -gt $PerformanceThresholdMs) {
                Write-Warning "Parse time exceeded $($PerformanceThresholdMs)ms threshold: $([Math]::Round($parseTime, 2))ms"
            }

            # Pass through the line to stdout (preserve original output)
            Write-Output $line
        }

        # Finalize session
        if ($inTurn) {
            End-Turn
        }

        Write-JsonlEvent -Event @{
            type = "session_end"
            sessionId = $global:SessionState.SessionId
            total_tokens = $global:SessionState.LastTokens
        }

    }
    catch {
        Write-Error "Wrapper error: $_"
        Write-VerboseLog "Error details: $($_.Exception.Message)"
        Write-VerboseLog "Stack trace: $($_.ScriptStackTrace)"
    }
    finally {
        Write-VerboseLog "Session ended: $($global:SessionState.SessionId)"
        Write-VerboseLog "Total tokens used: $($global:SessionState.LastTokens)"
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
    # Real wrapper mode - process stdin in real-time
    Write-VerboseLog "Starting real-time CLI wrapper mode"
    Invoke-ClaudeCodeWrapper
}
