# Token Optimizer Orchestrator
# Unified handler for ALL token optimization operations
# Replaces 15+ fragmented PowerShell handlers with direct MCP calls

param(
    [Parameter(Mandatory=$true)]
    [string]$Phase,

    [Parameter(Mandatory=$true)]
    [string]$Action
)

$HELPERS_DIR = "C:\Users\cheat\.claude-global\hooks\helpers"
$INVOKE_MCP = "$HELPERS_DIR\invoke-mcp.ps1"
$LOG_FILE = "C:\Users\cheat\.claude-global\hooks\logs\token-optimizer-orchestrator.log"
$SESSION_FILE = "C:\Users\cheat\.claude-global\hooks\data\current-session.txt"
$OPERATIONS_DIR = "C:\Users\cheat\.claude-global\hooks\data"

# Token budget configuration
$CONTEXT_LIMIT = 200000
$OPTIMIZE_THRESHOLD = 0.80
$FORCE_THRESHOLD = 0.90

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] [$Action] $Message"
    try {
        $logEntry | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Silently fail
    }
}

# Removed - now using direct invoke-mcp.ps1 calls

function Get-SessionInfo {
    if (Test-Path $SESSION_FILE) {
        try {
            $session = Get-Content $SESSION_FILE -Raw | ConvertFrom-Json
            return $session
        } catch {
            Write-Log "Failed to read session file: $($_.Exception.Message)" "ERROR"
        }
    }
    return $null
}

function Initialize-Session {
    # Create new session if needed
    if (-not (Test-Path $SESSION_FILE)) {
        $sessionId = [guid]::NewGuid().ToString()
        $sessionStart = Get-Date -Format "yyyyMMdd-HHmmss"

        $session = @{
            sessionId = $sessionId
            sessionStart = $sessionStart
            totalOperations = 0
            totalTokens = 0
            lastOptimized = 0
        }

        $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
        Write-Log "Initialized new session: $sessionId" "INFO"

        return $session
    }

    return Get-SessionInfo
}

function Update-SessionOperation {
    param([int]$TokensDelta = 0)

    $session = Initialize-Session

    $session.totalOperations++
    $session.totalTokens += $TokensDelta

    $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8

    return $session
}

function Handle-LogOperation {
    # Log ALL tool operations to operations-{sessionId}.csv for session-level optimization
    try {
        $input_json = [Console]::In.ReadToEnd()
        if (-not $input_json) {
            Write-Log "No input received for operation logging" "WARN"
            return
        }

        $data = $input_json | ConvertFrom-Json
        $toolName = $data.tool_name

        $session = Get-SessionInfo
        if (-not $session) {
            Write-Log "No active session for operation logging" "WARN"
            return
        }

        # Create CSV file path
        $csvFile = "$OPERATIONS_DIR\operations-$($session.sessionId).csv"

        # Extract file path and tokens for file-based operations
        $filePath = ""
        $tokens = 0
        $metadata = ""

        if ($toolName -eq "Read") {
            $filePath = $data.tool_input.file_path
            # Estimate tokens from response
            if ($data.tool_response -and $data.tool_response.file -and $data.tool_response.file.content) {
                $tokens = [Math]::Ceiling($data.tool_response.file.content.Length / 4)
            }
            $metadata = "filePath=$filePath"
        } elseif ($toolName -in @("Write", "Edit")) {
            $filePath = $data.tool_input.file_path
            $content = $data.tool_input.content
            if (-not $content) {
                $content = $data.tool_input.new_string
            }
            if ($content) {
                $tokens = [Math]::Ceiling($content.Length / 4)
            }
            $metadata = "filePath=$filePath"
        } else {
            # For other tools, log basic info
            $metadata = "toolName=$toolName"
        }

        # Append to CSV
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $csvLine = "$timestamp,$toolName,$tokens,`"$metadata`""

        # Create file with header if it doesn't exist
        if (-not (Test-Path $csvFile)) {
            "timestamp,toolName,tokens,metadata" | Out-File $csvFile -Encoding UTF8
        }

        $csvLine | Out-File $csvFile -Append -Encoding UTF8
        Write-Log "Logged operation: $toolName ($tokens tokens)" "DEBUG"

    } catch {
        Write-Log "Operation logging failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-OptimizeSession {
    # Run session-level batch optimization using optimize_session
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            Write-Log "No active session for optimization" "WARN"
            return
        }

        Write-Log "Running session-level optimization for session: $($session.sessionId)" "INFO"

        # Call optimize_session MCP tool
        $mcpArgs = @{
            sessionId = $session.sessionId
            min_token_threshold = 30
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__optimize_session" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result) {
            Write-Log "Session optimization completed: $($result.operationsCompressed) files optimized, $($result.tokens.saved) tokens saved ($($result.tokens.percentSaved)% reduction)" "INFO"
            Write-Log "Detailed stats: Before=$($result.tokens.before) After=$($result.tokens.after) Saved=$($result.tokens.saved)" "INFO"
        }

    } catch {
        Write-Log "Session optimization failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-ContextGuard {
    # Check context budget and trigger optimization if needed
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            return
        }

        $percentage = $session.totalTokens / $CONTEXT_LIMIT

        Write-Log "Context usage: $($session.totalTokens) / $CONTEXT_LIMIT ($([Math]::Round($percentage * 100, 1))%)" "DEBUG"

        if ($percentage -ge $FORCE_THRESHOLD) {
            Write-Log "CRITICAL: Context exhaustion at $([Math]::Round($percentage * 100, 1))%" "ERROR"

            # FORCE optimization
            $mcpArgs = @{
                sessionId = $session.sessionId
                min_token_threshold = 30
            }
            $argsJson = $mcpArgs | ConvertTo-Json -Compress
            $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__optimize_session" -ArgumentsJson $argsJson
            $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

            if ($result) {
                Write-Log "Emergency optimization completed" "INFO"
                $session.lastOptimized = $session.totalOperations
                $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
            } else {
                # BLOCK operation if optimization failed
                $blockResponse = @{
                    continue = $false
                    stopReason = "CRITICAL: Context budget exhausted. Automatic optimization failed. Please restart session."
                } | ConvertTo-Json -Compress

                Write-Output $blockResponse
                exit 2
            }

        } elseif ($percentage -ge $OPTIMIZE_THRESHOLD) {
            # Check if we've optimized recently
            $opsSinceOptimize = $session.totalOperations - $session.lastOptimized

            if ($opsSinceOptimize -ge 20) {
                Write-Log "WARNING: Context at $([Math]::Round($percentage * 100, 1))% - triggering optimization" "WARN"

                $mcpArgs = @{
                    sessionId = $session.sessionId
                    min_token_threshold = 30
                }
                $argsJson = $mcpArgs | ConvertTo-Json -Compress
                $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__optimize_session" -ArgumentsJson $argsJson
                $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

                if ($result) {
                    Write-Log "Proactive optimization completed" "INFO"
                    $session.lastOptimized = $session.totalOperations
                    $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
                }
            }
        }

    } catch {
        Write-Log "Context guard failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-PeriodicOptimize {
    # Run optimize_session every 50 operations
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            return
        }

        Write-Log "Periodic optimization triggered at operation #$($session.totalOperations)" "INFO"

        $mcpArgs = @{
            sessionId = $session.sessionId
            min_token_threshold = 30
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__optimize_session" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result) {
            Write-Log "Periodic optimization completed. Summary: $($result.summary)" "INFO"
            $session.lastOptimized = $session.totalOperations
            $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
        }

    } catch {
        Write-Log "Periodic optimize failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-CacheWarmup {
    # Pre-warm cache on session start using predictive cache
    try {
        Write-Log "Starting cache warmup" "INFO"

        # Use pattern-based warmup
        $mcpArgs = @{
            operation = "pattern-based"
            timeWindow = 3600000  # 1 hour
            minAccessCount = 2
            maxConcurrency = 5
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__cache_warmup" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result) {
            Write-Log "Cache warmup completed: $($result.keysWarmed) keys warmed" "INFO"
        }

    } catch {
        Write-Log "Cache warmup failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-SessionReport {
    # Generate comprehensive session analytics
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            return
        }

        Write-Log "Generating session report for session: $($session.sessionId)" "INFO"

        # Get session stats
        $mcpArgs = @{
            sessionId = $session.sessionId
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $statsJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__get_session_stats" -ArgumentsJson $argsJson
        $stats = if ($statsJson) { $statsJson | ConvertFrom-Json } else { $null }

        if ($stats) {
            Write-Log "Session stats: $($stats | ConvertTo-Json -Compress)" "INFO"

            # Generate project-level analysis
            $mcpArgs = @{
                projectPath = "C:\Users\cheat\.claude-global\hooks"
                costPerMillionTokens = 30
            }
            $argsJson = $mcpArgs | ConvertTo-Json -Compress
            $analysisJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__analyze_project_tokens" -ArgumentsJson $argsJson
            $analysis = if ($analysisJson) { $analysisJson | ConvertFrom-Json } else { $null }

            if ($analysis) {
                Write-Log "Project analysis: Total tokens: $($analysis.totalTokens), Estimated cost: `$$($analysis.estimatedCost)" "INFO"
            }
        }

    } catch {
        Write-Log "Session report failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-SmartRead {
    # Use smart_read MCP tool for intelligent file reading with built-in caching
    # This replaces plain Read with cache-aware, diff-based, truncated reading
    try {
        $input_json = [Console]::In.ReadToEnd()
        if (-not $input_json) {
            Write-Log "No input received for smart-read" "WARN"
            return
        }

        $data = $input_json | ConvertFrom-Json
        $toolName = $data.tool_name

        # Only intercept Read operations
        if ($toolName -ne "Read") {
            return
        }

        $filePath = $data.tool_input.file_path
        if (-not $filePath) {
            Write-Log "No file path in Read operation" "WARN"
            return
        }

        Write-Log "Calling smart_read for: $filePath" "DEBUG"

        # Call smart_read MCP tool with caching enabled
        $mcpArgs = @{
            path = $filePath
            enableCache = $true
            diffMode = $true
            maxSize = 100000
            includeMetadata = $true
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__smart_read" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result -and $result.content) {
            # SUCCESS - Block plain Read and return smart_read result
            $fromCache = if ($result.metadata.fromCache) { "CACHE HIT" } else { "NEW READ" }
            $isDiff = if ($result.metadata.isDiff) { "DIFF" } else { "FULL" }
            $tokens = $result.metadata.tokenCount
            $tokensSaved = if ($result.metadata.tokensSaved) { $result.metadata.tokensSaved } else { 0 }

            Write-Log "$fromCache - $isDiff: $filePath ($tokens tokens, saved $tokensSaved)" "INFO"

            # Return smart_read result and block plain Read
            $blockResponse = @{
                continue = $false
                stopReason = "smart_read success"
                hookSpecificOutput = @{
                    hookEventName = "PreToolUse"
                    smartRead = $true
                    filePath = $filePath
                    content = $result.content
                    metadata = $result.metadata
                }
            } | ConvertTo-Json -Depth 10 -Compress

            Write-Output $blockResponse
            exit 2

        } else {
            # FAILED - Allow plain Read to proceed
            Write-Log "smart_read failed for $filePath - falling back to plain Read" "WARN"
        }

    } catch {
        Write-Log "smart_read failed: $($_.Exception.Message)" "ERROR"
        # On error, allow plain Read to proceed
    }
}

# Main execution
try {
    Write-Log "Phase: $Phase, Action: $Action" "INFO"

    switch ($Action) {
        "smart-read" {
            Handle-SmartRead
        }
        "context-guard" {
            Handle-ContextGuard
        }
        "periodic-optimize" {
            Handle-PeriodicOptimize
        }
        "cache-warmup" {
            Handle-CacheWarmup
        }
        "session-report" {
            Handle-SessionReport
        }
        "log-operation" {
            Handle-LogOperation
        }
        "optimize-session" {
            Handle-OptimizeSession
        }
        "session-track" {
            # Update operation count
            $session = Update-SessionOperation
            Write-Log "Operation #$($session.totalOperations)" "DEBUG"
        }
        Default {
            Write-Log "Unknown action: $Action" "WARN"
        }
    }

    exit 0

} catch {
    Write-Log "Orchestrator failed: $($_.Exception.Message)" "ERROR"
    exit 0  # Never block on error
}
