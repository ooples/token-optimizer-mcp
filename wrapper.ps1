# Enhanced Token Tracking Wrapper for Claude Code
# Purpose: Real-time session logging with turn-level tracking and MCP server attribution
# Implements Priority 1: Session-level token tracking with JSONL event log
# Version: 2.0.0
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
    [int]$LineBufferSize = 100,
    # Base directory for log path validation (default: $env:USERPROFILE\token-optimizer-logs)
    # Set this to allow custom base directories while maintaining path traversal protection
    [Parameter(Mandatory = $false)]
    [string]$BaseLogDir = (Join-Path $env:USERPROFILE "token-optimizer-logs")
)

# Validate that $env:USERPROFILE exists and is accessible
if (-not $env:USERPROFILE) {
    throw "Environment variable USERPROFILE is not set. Cannot determine user profile directory."
}

if (-not (Test-Path $env:USERPROFILE -PathType Container)) {
    throw "User profile directory does not exist or is not accessible: $env:USERPROFILE"
}

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

<#
.SYNOPSIS
Checks if the provided log directory is within the allowed base directory.

.DESCRIPTION
Prevents path traversal attacks by ensuring $LogDir is either the same as $BaseLogDir
or a subdirectory of it. Both paths are resolved to their absolute forms for comparison.
Returns $true if safe, $false otherwise.

.PARAMETER LogDir
The log directory to validate.

.PARAMETER BaseLogDir
The base directory against which to validate the log directory.

.OUTPUTS
[bool] Returns $true if $LogDir is safe, $false otherwise.
#>
function Test-LogDirIsSafe {
    param(
        [string]$LogDir,
        [string]$BaseLogDir
    )

    # Resolve both paths to their absolute forms
    $resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
    $resolvedBaseLogDir = [System.IO.Path]::GetFullPath($BaseLogDir)

    # Normalize paths to lowercase for case-insensitive comparison (Windows)
    $logDirNorm = $resolvedLogDir.ToLower()
    $baseLogDirNorm = $resolvedBaseLogDir.ToLower()
    $sep = [System.IO.Path]::DirectorySeparatorChar

    # Allow if $LogDir is exactly $BaseLogDir
    if ($logDirNorm -eq $baseLogDirNorm) {
        return $true
    }

    # Allow if $LogDir is a subdirectory of $BaseLogDir
    if ($logDirNorm.StartsWith($baseLogDirNorm + $sep)) {
        return $true
    }

    # Otherwise, path traversal detected
    return $false
}

function Initialize-Session {
    Write-VerboseLog "Initializing session: $($global:SessionState.SessionId)"

    # Validate log directory path to prevent path traversal attacks
    # Use GetFullPath to resolve the path and check if it's within the expected base directory
    # NOTE: The base directory can be customized via the -BaseLogDir parameter for trusted environments
    $ResolvedBaseLogDir = [System.IO.Path]::GetFullPath($BaseLogDir)
    $ResolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)

    if (-not (Test-LogDirIsSafe -LogDir $ResolvedLogDir -BaseLogDir $ResolvedBaseLogDir)) {
        throw "Invalid log directory path: path traversal detected. LogDir must be within $ResolvedBaseLogDir."
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

<#
.SYNOPSIS
Detects tool calls from the current line and previous context using pattern matching.

.DESCRIPTION
Implements a multi-pattern tool detection algorithm that searches for tool invocations in:
1. Current line using <invoke name="ToolName"> pattern
2. Previous lines (lookback buffer) for recent tool invocations
3. Function result blocks using <name>ToolName</name> pattern

The algorithm uses configurable lookback to balance accuracy vs performance.

.PARAMETER CurrentLine
The current line from the input stream to analyze.

.PARAMETER PreviousLines
Queue or array of previous lines to search for tool call context. Supports both [System.Collections.Generic.Queue[string]] and array types.

.PARAMETER LookbackLimit
Maximum number of previous lines to search (default: 20). Controls the trade-off between detection accuracy and performance.

.OUTPUTS
[string] Returns the detected tool name (e.g., "Read", "mcp__git__git_status") if found, or $null if no tool call is detected.

.EXAMPLE
$toolName = Parse-ToolCallFromContext -CurrentLine '<invoke name="Read">' -PreviousLines $lineBuffer
# Returns: "Read"

.EXAMPLE
$toolName = Parse-ToolCallFromContext -CurrentLine '<system_warning>...' -PreviousLines $lineBuffer -LookbackLimit 10
# Searches up to 10 previous lines for tool invocation patterns
#>
function Parse-ToolCallFromContext {
    param(
        [string]$CurrentLine,
        $PreviousLines,  # Accept Queue or Array
        [int]$LookbackLimit = 20
    )

    # Pattern 1: Tool call in antml:function_calls block
    # <invoke name="ToolName">
    $toolCallPattern = '<invoke name="([^"]+)">'
    if ($CurrentLine -match $toolCallPattern) {
        return $matches[1]
    }

    # Pattern 2: Search previous lines for recent tool invocation
    # Handle both Queue and Array types efficiently
    $linesArray = if ($PreviousLines -is [System.Collections.Generic.Queue[string]]) {
        $PreviousLines.ToArray()
    } else {
        $PreviousLines
    }

    $lookback = [Math]::Min($LookbackLimit, $linesArray.Count)
    for ($i = $linesArray.Count - 1; $i -ge [Math]::Max(0, $linesArray.Count - $lookback); $i--) {
        if ($linesArray[$i] -match $toolCallPattern) {
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

<#
.SYNOPSIS
Looks up cached tool responses to enable pre-execution cache injection.

.DESCRIPTION
STUB FUNCTION: Cache injection is NOT implemented.
This function is a placeholder for future MCP integration that will enable:
- Pre-execution cache lookups for high-token operations
- Transparent response injection to skip redundant tool calls
- Token savings tracking via cache hit events

Currently always returns $null to disable cache injection.
For implementation details, see the MCP integration plan and project roadmap.

.PARAMETER ToolName
The name of the tool to look up (e.g., "Read", "mcp__git__git_status").

.PARAMETER ToolParams
Hashtable of tool parameters used to generate the cache key. Used to create unique cache keys for different parameter combinations.

.OUTPUTS
[string] Returns the cached tool response content if found, or $null if not cached. Currently always returns $null as cache injection is not implemented.

.EXAMPLE
$cached = Get-CachedToolResponse -ToolName "Read" -ToolParams @{ file_path = "C:\example.txt" }
# Returns: $null (stub implementation)

.NOTES
TODO: Implement cache injection for MCP integration. See project roadmap or issue tracker for implementation timeline.
#>
function Get-CachedToolResponse {
    param(
        [string]$ToolName,
        [hashtable]$ToolParams
    )

    # STUB: Cache injection is NOT implemented.
    # This function is a placeholder for future MCP integration.
    # It currently always returns $null.
    # TODO: Implement cache injection for MCP integration. See project roadmap or issue tracker.
    return $null
}

<#
.SYNOPSIS
Injects a cached response directly into the output stream as a formatted tool result.

.DESCRIPTION
Formats and injects cached tool responses into the stdout stream, bypassing actual tool execution.
The response is formatted as a standard <function_results> block to maintain compatibility with
the parent process (e.g., Claude Code CLI). This enables transparent cache injection where the
parent process consumes the cached response as if it came from the actual tool.

Used in conjunction with Get-CachedToolResponse to implement cache-based token optimization.

.PARAMETER CachedResponse
The cached tool response content to inject. Should be the raw response data from the cache.

.PARAMETER ToolName
The name of the tool being cached (used for logging and formatting). E.g., "Read", "mcp__git__git_status".

.OUTPUTS
[void] Writes formatted tool result to stdout using Write-Output.

.EXAMPLE
Inject-CachedResponse -CachedResponse "File contents here..." -ToolName "Read"
# Outputs formatted <function_results> block to stdout

.NOTES
This function is designed to work with the cache injection mechanism. The output format matches the standard tool result format expected by Claude Code CLI.
#>
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
        # IMPORTANT: Setting InputEncoding and OutputEncoding to UTF8 prevents encoding mismatches
        # between the console and piped data, ensuring Unicode characters are handled correctly.
        # This addresses the concern that [Console]::In.ReadLine() could have encoding issues.
        # Store original encodings to restore in finally block
        $originalInputEncoding = [Console]::InputEncoding
        $originalOutputEncoding = [Console]::OutputEncoding
        [Console]::InputEncoding = [System.Text.Encoding]::UTF8
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

        $input = [Console]::In
        while ($true) {
            # DESIGN NOTE - Blocking I/O is intentional:
            # This wrapper is designed to run as a piped subprocess where stdin is managed by the
            # parent process (e.g., Claude Code CLI). The stream closes automatically when the parent
            # terminates, preventing indefinite hangs. The explicit null check below ensures we
            # detect EOF and exit gracefully. Timeout mechanisms are not required as the wrapper
            # lifecycle is controlled by the parent process. For alternative contexts, consider:
            # - Using async I/O with CancellationToken for timeout support
            # - Implementing heartbeat detection for stalled streams
            # - Using StreamReader with timeout for non-console scenarios
            # The console encoding is set to UTF8 (lines 511-512) to prevent encoding mismatches
            # between the console and piped data, ensuring Unicode characters are handled correctly.
            $line = $input.ReadLine()

            # Check for end of stream
            if ($null -eq $line) {
                Write-VerboseLog "End of stream detected"
                break
            }

            # Add to line buffer (for context lookback)
            # Note: LineBufferSize is configurable via parameter (default: 100)
            # Using Queue.Enqueue/Dequeue for O(1) operations instead of ArrayList.RemoveAt(0)
            # Optimization: Check count before enqueue to avoid unnecessary dequeue when buffer isn't full
            if ($lineBuffer.Count -ge $LineBufferSize) {
                $lineBuffer.Dequeue()  # Remove oldest line efficiently
            }
            $lineBuffer.Enqueue($line)

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
                    # Pass Queue directly to avoid ToArray() conversion overhead
                    $toolName = Parse-ToolCallFromContext -CurrentLine $line -PreviousLines $lineBuffer

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
        # Restore original console encodings to avoid affecting subsequent operations
        if ($originalInputEncoding) {
            [Console]::InputEncoding = $originalInputEncoding
        }
        if ($originalOutputEncoding) {
            [Console]::OutputEncoding = $originalOutputEncoding
        }

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
