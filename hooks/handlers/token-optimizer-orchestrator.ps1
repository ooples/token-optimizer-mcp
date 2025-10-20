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

function Handle-CacheRetrieval {
    # CRITICAL: Check cache BEFORE Read executes to save tokens
    # This is the missing piece that enables actual token savings
    try {
        $input_json = [Console]::In.ReadToEnd()
        if (-not $input_json) {
            Write-Log "No input received for cache retrieval" "WARN"
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

        Write-Log "Checking cache for: $filePath" "DEBUG"

        # Call get_cached MCP tool
        $mcpArgs = @{
            key = $filePath
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "mcp__token-optimizer__get_cached" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result -and $result.success -and $result.fromCache) {
            # CACHE HIT - Block the Read and inject cached content
            Write-Log "CACHE HIT: $filePath (saved tokens!)" "INFO"

            # Count tokens in cached vs original
            $cachedText = $result.text
            $cachedTokens = [Math]::Ceiling($cachedText.Length / 4)

            Write-Log "Cache retrieval stats: Cached content: $cachedTokens estimated tokens" "INFO"

            # BLOCK the Read operation and return cached content
            # This is done by exiting with code 2 and providing a custom response
            $blockResponse = @{
                continue = $false
                stopReason = "CACHE HIT"
                hookSpecificOutput = @{
                    hookEventName = "PreToolUse"
                    cacheHit = $true
                    filePath = $filePath
                    cachedContent = $cachedText
                    estimatedTokens = $cachedTokens
                }
            } | ConvertTo-Json -Depth 10 -Compress

            Write-Output $blockResponse
            exit 2

        } else {
            # CACHE MISS - Allow Read to proceed
            Write-Log "Cache miss: $filePath (will cache after Read)" "DEBUG"
        }

    } catch {
        Write-Log "Cache retrieval failed: $($_.Exception.Message)" "ERROR"
        # On error, allow Read to proceed normally
    }
}

# Main execution
try {
    Write-Log "Phase: $Phase, Action: $Action" "INFO"

    switch ($Action) {
        "auto-cache" {
            Handle-AutoCache
        }
        "cache-retrieval" {
            Handle-CacheRetrieval
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
