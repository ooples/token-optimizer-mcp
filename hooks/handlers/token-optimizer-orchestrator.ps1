# Token Optimizer Orchestrator
# Unified handler for ALL token optimization operations
# Replaces 15+ fragmented PowerShell handlers with direct MCP calls

# CRITICAL FIX: Removed param block that consumed stdin when dot-sourced!
# The Mandatory=$true parameters were trying to read from stdin during dot-sourcing,
# consuming the JSON input before dispatcher.ps1 could read it.
# Functions now receive their inputs via parameters (e.g., $InputJson)

$HELPERS_DIR = "C:\Users\cheat\.claude-global\hooks\helpers"
$INVOKE_MCP = "$HELPERS_DIR\invoke-mcp.ps1"
$LOG_FILE = "C:\Users\cheat\.claude-global\hooks\logs\token-optimizer-orchestrator.log"
$SESSION_FILE = "C:\Users\cheat\.claude-global\hooks\data\current-session.txt"
$OPERATIONS_DIR = "C:\Users\cheat\.claude-global\hooks\data"

# PERFORMANCE FIX: Prefer local dev path if not already set
if (-not $env:TOKEN_OPTIMIZER_DEV_PATH) {
  $home = $env:USERPROFILE; if (-not $home) { $home = (Get-Item "~").FullName }
  $env:TOKEN_OPTIMIZER_DEV_PATH = (Join-Path $home "source\repos\token-optimizer-mcp")
}

# Token budget configuration
$CONTEXT_LIMIT = 200000
$OPTIMIZE_THRESHOLD = 0.80
$FORCE_THRESHOLD = 0.90

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('DEBUG','INFO','WARN','ERROR')][string]$Level = "INFO",
        [string]$Context = ""
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $contextPart = if ($Context) { " [$Context]" } else { "" }
    $logEntry = "[$timestamp] [$Level]$contextPart $Message"
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
    param([string]$InputJson)
    # Log ALL tool operations to operations-{sessionId}.csv for session-level optimization
    try {
        if (-not $InputJson) {
            Write-Log "No input received for operation logging" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
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
    param([string]$InputJson)
    # Check context budget and trigger optimization if needed
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            return 0
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
                # BLOCK with standard response so dispatcher exits with 2
                $blockResponse = @{
                    continue = $false
                    stopReason = "context guard block"
                    hookSpecificOutput = @{
                        hookEventName = "PreToolUse"
                        reason = "optimize_session failed at FORCE_THRESHOLD"
                        sessionId = $session.sessionId
                        usagePercent = [Math]::Round($percentage * 100, 1)
                    }
                } | ConvertTo-Json -Depth 10 -Compress
                Write-Output $blockResponse
                [Console]::Out.Flush(); [Console]::Error.Flush()
                return 2
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

        return 0  # Success - allow operation to proceed

    } catch {
        Write-Log "Context guard failed: $($_.Exception.Message)" "ERROR"
        return 0  # On error, don't block
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

function Handle-UserPromptOptimization {
    param([string]$InputJson)
    # PHASE 2: UserPromptSubmit - Optimize user prompt before processing
    # Uses: count_tokens, optimize_text, predictive_cache, natural-language-query
    try {
        if (-not $InputJson) {
            Write-Log "No input received for prompt optimization" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $userPrompt = if ($data.user_prompt) { $data.user_prompt } else { "" }

        if (-not $userPrompt) {
            Write-Log "No user prompt to optimize" "DEBUG"
            return
        }

        Write-Log "Optimizing user prompt" "INFO"

        # Count tokens in original prompt
        $beforeTokens = 0
        try {
            $countArgs = @{ text = $userPrompt }
            $countJson = $countArgs | ConvertTo-Json -Compress
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            $countData = if ($countResult) { $countResult | ConvertFrom-Json } else { $null }
            if ($countData -and $countData.content) {
                $beforeTokens = [int]($countData.content[0].text)
            }
        } catch {
            Write-Log "Prompt token counting failed: $($_.Exception.Message)" "WARN"
        }

        # Check predictive cache
        try {
            $cacheArgs = @{
                operation = "predict"
                modelType = "hybrid"
                maxPredictions = 5
                confidence = 0.7
            }
            $cacheJson = $cacheArgs | ConvertTo-Json -Compress
            $cacheResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive_cache" -ArgumentsJson $cacheJson
        } catch {
            # Silent fail - cache is optional
        }

        # Optimize prompt (PHASE 4: Skip for small texts < 500 chars)
        if ($userPrompt.Length -lt 500) {
            Write-Log "Skipping optimization for small prompt ($($userPrompt.Length) chars)" "DEBUG"
            return
        }

        try {
            $optimizeArgs = @{
                text = $userPrompt
                key = "user_prompt_$(Get-Date -Format 'yyyyMMddHHmmss')"
                quality = 7  # PHASE 4: Reduced from 11 to 7 for performance
            }
            $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
            $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson
            $optimizeData = if ($optimizeResult) { $optimizeResult | ConvertFrom-Json } else { $null }

            if ($optimizeData -and $optimizeData.content) {
                $afterTokens = if ($optimizeData.metadata -and $optimizeData.metadata.compressedTokens) {
                    $optimizeData.metadata.compressedTokens
                } else { $beforeTokens }
                $saved = $beforeTokens - $afterTokens
                $percent = if ($beforeTokens -gt 0) { [math]::Round(($saved / $beforeTokens) * 100, 1) } else { 0 }
                Write-Log "Optimized user prompt: $beforeTokens → $afterTokens tokens ($percent% reduction)" "INFO"
            }
        } catch {
            Write-Log "Prompt optimization failed: $($_.Exception.Message)" "ERROR"
        }

    } catch {
        Write-Log "UserPromptOptimization handler failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-SessionStartInit {
    # PHASE 2: SessionStart - Initialize caching and monitoring
    # Uses: cache_warmup, get_session_stats, health_monitor
    try {
        Write-Log "Initializing session with Phase 2 optimizations" "INFO"

        # Initialize session
        $session = Initialize-Session
        Write-Log "Session initialized: $($session.sessionId)" "INFO"

        # Trigger cache warmup
        try {
            $warmupArgs = @{
                operation = "schedule"
                strategy = "progressive"
                batchSize = 50
                priority = "normal"
            }
            $warmupJson = $warmupArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_warmup" -ArgumentsJson $warmupJson
            Write-Log "Cache warmup scheduled" "INFO"
        } catch {
            Write-Log "Cache warmup failed: $($_.Exception.Message)" "WARN"
        }

        # Get cache stats
        try {
            $statsResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "get_cache_stats" -ArgumentsJson "{}"
            $statsData = if ($statsResult) { $statsResult | ConvertFrom-Json } else { $null }
            if ($statsData -and $statsData.content) {
                $stats = $statsData.content[0].text | ConvertFrom-Json
                Write-Log "Cache stats: Hit rate: $($stats.hitRate), Entries: $($stats.entries)" "INFO"
            }
        } catch {
            Write-Log "Failed to get cache stats: $($_.Exception.Message)" "WARN"
        }

        # Health monitor check
        try {
            $healthArgs = @{ operation = "check-health" }
            $healthJson = $healthArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "health_monitor" -ArgumentsJson $healthJson
            Write-Log "Health monitor check completed" "INFO"
        } catch {
            Write-Log "Health monitor failed: $($_.Exception.Message)" "WARN"
        }

    } catch {
        Write-Log "SessionStartInit handler failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-SmartDiff {
    # PHASE 7: Generate compact diffs for file changes
    # Uses: smart_diff for efficient change representation
    param(
        [string]$Source = "HEAD",
        [string]$Target = "",
        [array]$Files = @()
    )

    try {
        Write-Log "Generating smart diff" "DEBUG"

        $diffArgs = @{
            source = $Source
        }

        if ($Target) {
            $diffArgs.target = $Target
        }

        if ($Files.Count -gt 0) {
            $diffArgs.files = $Files
        }

        $diffArgs.summaryOnly = $false
        $diffArgs.contextLines = 3

        $diffJson = $diffArgs | ConvertTo-Json -Compress -Depth 5
        $diffResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_diff" -ArgumentsJson $diffJson

        if ($diffResult) {
            $diffData = $diffResult | ConvertFrom-Json
            if ($diffData -and $diffData.content) {
                Write-Log "Smart diff generated" "DEBUG"
                return $diffData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "SmartDiff handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-SmartLogs {
    # PHASE 7: Process and optimize log outputs
    # Uses: smart_logs for log aggregation and filtering
    param(
        [array]$Sources = @(),
        [string]$Level = "all",
        [int]$Tail = 100
    )

    try {
        Write-Log "Processing smart logs" "DEBUG"

        $logsArgs = @{
            tail = $Tail
            level = $Level
        }

        if ($Sources.Count -gt 0) {
            $logsArgs.sources = $Sources
        }

        $logsJson = $logsArgs | ConvertTo-Json -Compress -Depth 5
        $logsResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_logs" -ArgumentsJson $logsJson

        if ($logsResult) {
            $logsData = $logsResult | ConvertFrom-Json
            if ($logsData -and $logsData.content) {
                Write-Log "Smart logs processed" "DEBUG"
                return $logsData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "SmartLogs handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-ToolSpecificOptimization {
    # PHASE 7: Apply tool-specific optimization based on tool type
    param(
        [string]$ToolName,
        [string]$ToolOutput
    )

    try {
        Write-Log "Applying tool-specific optimization for: $ToolName" "DEBUG"

        # API/Database tools - compress JSON responses
        if ($ToolName -match "^(smart_api_fetch|smart_database|smart_graphql|smart_rest|smart_sql|smart_schema)") {
            try {
                $compressed = Handle-CacheCompression -Data $ToolOutput -DataType "json"
                if ($compressed) {
                    return $compressed
                }
            } catch {
                # Fall through to default
            }
        }

        # Git/File operations - use diff format
        if ($ToolName -match "^(smart_diff|smart_status|smart_log|Read|Edit|Write)") {
            # Already optimized by smart_* tools
            return $ToolOutput
        }

        # Build/Test tools - summarize verbose output
        if ($ToolName -match "^(smart_build|smart_test|smart_lint|smart_typecheck)") {
            try {
                $summarized = Handle-IntelligentSummarization -Text $ToolOutput -Context "build"
                if ($summarized -and $summarized.Length -lt $ToolOutput.Length) {
                    return $summarized
                }
            } catch {
                # Fall through to default
            }
        }

        # Log tools - filter and aggregate
        if ($ToolName -match "^(smart_logs|log_dashboard)") {
            # Already optimized
            return $ToolOutput
        }

        # Default: apply general optimization
        return $ToolOutput

    } catch {
        Write-Log "ToolSpecificOptimization handler failed: $($_.Exception.Message)" "ERROR"
        return $ToolOutput
    }
}

function Handle-MetricCollector {
    # PHASE 6: Comprehensive metric collection
    # Uses: metric_collector for operation metrics
    param(
        [string]$Operation,
        [hashtable]$Query = @{}
    )

    try {
        Write-Log "Collecting metrics for operation: $Operation" "DEBUG"

        $metricArgs = @{
            operation = $Operation
        }

        if ($Query.Count -gt 0) {
            $metricArgs.query = $Query
        }

        $metricJson = $metricArgs | ConvertTo-Json -Compress -Depth 5
        $metricResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "metric_collector" -ArgumentsJson $metricJson

        if ($metricResult) {
            $metricData = $metricResult | ConvertFrom-Json
            if ($metricData -and $metricData.content) {
                Write-Log "Metrics collected: $($metricData.content[0].text)" "DEBUG"
                return $metricData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "MetricCollector handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-AlertManager {
    # PHASE 6: Alert management for optimization issues
    # Uses: alert_manager for threshold alerts
    param(
        [string]$Operation,
        [hashtable]$Config = @{}
    )

    try {
        Write-Log "Alert manager operation: $Operation" "DEBUG"

        $alertArgs = @{
            operation = $Operation
        }

        if ($Config.Count -gt 0) {
            foreach ($key in $Config.Keys) {
                $alertArgs[$key] = $Config[$key]
            }
        }

        $alertJson = $alertArgs | ConvertTo-Json -Compress -Depth 5
        $alertResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "alert_manager" -ArgumentsJson $alertJson

        if ($alertResult) {
            $alertData = $alertResult | ConvertFrom-Json
            if ($alertData -and $alertData.content) {
                Write-Log "Alert: $($alertData.content[0].text)" "INFO"
                return $alertData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "AlertManager handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-HealthMonitor {
    # PHASE 6: System health monitoring
    # Uses: health_monitor for system checks
    param(
        [string]$Operation = "check-health"
    )

    try {
        Write-Log "Health monitor: $Operation" "DEBUG"

        $healthArgs = @{
            operation = $Operation
        }
        $healthJson = $healthArgs | ConvertTo-Json -Compress -Depth 5
        $healthResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "health_monitor" -ArgumentsJson $healthJson

        if ($healthResult) {
            $healthData = $healthResult | ConvertFrom-Json
            if ($healthData -and $healthData.content) {
                Write-Log "Health status: $($healthData.content[0].text)" "DEBUG"
                return $healthData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "HealthMonitor handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-MonitoringIntegration {
    # PHASE 6: External monitoring platform integration
    # Uses: monitoring_integration for external dashboards
    param(
        [string]$Operation,
        [hashtable]$Connection = @{}
    )

    try {
        Write-Log "Monitoring integration: $Operation" "DEBUG"

        $monitorArgs = @{
            operation = $Operation
        }

        if ($Connection.Count -gt 0) {
            $monitorArgs.connection = $Connection
        }

        $monitorJson = $monitorArgs | ConvertTo-Json -Compress -Depth 5
        $monitorResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "monitoring_integration" -ArgumentsJson $monitorJson

        if ($monitorResult) {
            $monitorData = $monitorResult | ConvertFrom-Json
            if ($monitorData -and $monitorData.content) {
                Write-Log "Monitoring integration: $($monitorData.content[0].text)" "DEBUG"
                return $monitorData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "MonitoringIntegration handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-AnalyzeOptimization {
    # PHASE 6: Analyze optimization effectiveness
    # Uses: analyze_optimization for feedback
    param(
        [string]$Text
    )

    try {
        if (-not $Text) {
            return $null
        }

        Write-Log "Analyzing optimization effectiveness" "DEBUG"

        $analyzeArgs = @{
            text = $Text
        }
        $analyzeJson = $analyzeArgs | ConvertTo-Json -Compress -Depth 5
        $analyzeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "analyze_optimization" -ArgumentsJson $analyzeJson

        if ($analyzeResult) {
            $analyzeData = $analyzeResult | ConvertFrom-Json
            if ($analyzeData -and $analyzeData.content) {
                Write-Log "Optimization analysis: $($analyzeData.content[0].text)" "DEBUG"
                return $analyzeData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "AnalyzeOptimization handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-CacheAnalytics {
    # PHASE 5: Advanced cache analytics
    # Uses: cache_analytics for performance insights
    try {
        Write-Log "Running cache analytics" "DEBUG"

        $analyticsArgs = @{
            operation = "dashboard"
            metricTypes = @("performance", "usage", "efficiency")
        }
        $analyticsJson = $analyticsArgs | ConvertTo-Json -Compress -Depth 5
        $analyticsResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_analytics" -ArgumentsJson $analyticsJson

        if ($analyticsResult) {
            $analyticsData = $analyticsResult | ConvertFrom-Json
            if ($analyticsData -and $analyticsData.content) {
                Write-Log "Cache analytics: $($analyticsData.content[0].text)" "INFO"
                return $analyticsData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "CacheAnalytics handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-CacheOptimizer {
    # PHASE 5: Cache optimization recommendations
    # Uses: cache_optimizer for strategy recommendations
    try {
        Write-Log "Running cache optimizer" "DEBUG"

        $optimizerArgs = @{
            operation = "analyze"
            analysisWindow = 3600000
            objective = "balanced"
        }
        $optimizerJson = $optimizerArgs | ConvertTo-Json -Compress -Depth 5
        $optimizerResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_optimizer" -ArgumentsJson $optimizerJson

        if ($optimizerResult) {
            $optimizerData = $optimizerResult | ConvertFrom-Json
            if ($optimizerData -and $optimizerData.content) {
                Write-Log "Cache optimizer recommendations: $($optimizerData.content[0].text)" "DEBUG"
                return $optimizerData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "CacheOptimizer handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-CacheCompression {
    # PHASE 5: Advanced cache compression
    # Uses: cache_compression for optimal compression
    param(
        [string]$Data,
        [string]$DataType = "auto"
    )

    try {
        if (-not $Data -or $Data.Length -lt 100) {
            return $Data
        }

        Write-Log "Applying cache compression" "DEBUG"

        $compressionArgs = @{
            operation = "compress"
            data = $Data
            dataType = $DataType
            autoSelect = $true
        }
        $compressionJson = $compressionArgs | ConvertTo-Json -Compress -Depth 5
        $compressionResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_compression" -ArgumentsJson $compressionJson

        if ($compressionResult) {
            $compressionData = $compressionResult | ConvertFrom-Json
            if ($compressionData -and $compressionData.content) {
                Write-Log "Data compressed successfully" "DEBUG"
                return $compressionData.content[0].text
            }
        }

        return $Data

    } catch {
        Write-Log "CacheCompression handler failed: $($_.Exception.Message)" "ERROR"
        return $Data
    }
}

function Handle-CacheInvalidation {
    # PHASE 5: Intelligent cache invalidation
    # Uses: cache_invalidation for dependency-based invalidation
    param(
        [string]$Pattern,
        [string]$Mode = "lazy"
    )

    try {
        Write-Log "Running cache invalidation: $Pattern" "DEBUG"

        $invalidationArgs = @{
            operation = "invalidate-pattern"
            pattern = $Pattern
            mode = $Mode
        }
        $invalidationJson = $invalidationArgs | ConvertTo-Json -Compress -Depth 5
        & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_invalidation" -ArgumentsJson $invalidationJson

        Write-Log "Cache invalidation completed for pattern: $Pattern" "DEBUG"

    } catch {
        Write-Log "CacheInvalidation handler failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-SmartCache {
    # PHASE 5: Multi-tier smart caching
    # Uses: smart_cache for L1/L2/L3 tiered storage
    param(
        [string]$Operation,
        [string]$Key,
        [string]$Value = $null,
        [string]$Tier = "L1"
    )

    try {
        Write-Log "Smart cache $Operation for key: $Key" "DEBUG"

        $cacheArgs = @{
            operation = $Operation
            key = $Key
        }

        if ($Value) {
            $cacheArgs.value = $Value
            $cacheArgs.tier = $Tier
        }

        $cacheJson = $cacheArgs | ConvertTo-Json -Compress -Depth 5
        $cacheResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_cache" -ArgumentsJson $cacheJson

        if ($cacheResult) {
            $cacheData = $cacheResult | ConvertFrom-Json
            if ($cacheData -and $cacheData.content) {
                return $cacheData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "SmartCache handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-IntelligentSummarization {
    # PHASE 4: Intelligent summarization for large outputs
    # Uses: smart-summarization, pattern-recognition, predictive-analytics
    param(
        [string]$Text,
        [string]$Context = "general"
    )

    try {
        if (-not $Text -or $Text.Length -lt 500) {
            return $Text
        }

        Write-Log "Applying intelligent summarization (length: $($Text.Length))" "INFO"

        # Use smart-summarization tool
        try {
            $summarizeArgs = @{
                operation = "summarize"
                query = $Text
                data = @{
                    context = $Context
                    maxLength = 200
                }
            }
            $summarizeJson = $summarizeArgs | ConvertTo-Json -Compress -Depth 5
            $summarizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart-summarization" -ArgumentsJson $summarizeJson

            if ($summarizeResult) {
                $summarizeData = $summarizeResult | ConvertFrom-Json
                if ($summarizeData -and $summarizeData.content) {
                    $summarized = $summarizeData.content[0].text
                    Write-Log "Summarized from $($Text.Length) to $($summarized.Length) chars" "INFO"
                    return $summarized
                }
            }
        } catch {
            Write-Log "Summarization failed: $($_.Exception.Message)" "WARN"
        }

        return $Text

    } catch {
        Write-Log "IntelligentSummarization handler failed: $($_.Exception.Message)" "ERROR"
        return $Text
    }
}

function Handle-PatternRecognition {
    # PHASE 4: Pattern recognition for recurring data
    # Uses: pattern-recognition to identify and abstract patterns
    param(
        [string]$Text
    )

    try {
        if (-not $Text -or $Text.Length -lt 200) {
            return $null
        }

        Write-Log "Running pattern recognition" "DEBUG"

        # Detect patterns in the text
        try {
            $patternArgs = @{
                operation = "detect-patterns"
                query = $Text
                data = @{
                    minSupport = 2
                    confidence = 0.6
                }
            }
            $patternJson = $patternArgs | ConvertTo-Json -Compress -Depth 5
            $patternResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "pattern-recognition" -ArgumentsJson $patternJson

            if ($patternResult) {
                $patternData = $patternResult | ConvertFrom-Json
                if ($patternData -and $patternData.content) {
                    Write-Log "Patterns detected: $($patternData.content[0].text)" "DEBUG"
                    return $patternData.content[0].text
                }
            }
        } catch {
            Write-Log "Pattern recognition failed: $($_.Exception.Message)" "DEBUG"
        }

        return $null

    } catch {
        Write-Log "PatternRecognition handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-PredictiveAnalytics {
    # PHASE 4: Predictive analytics for context selection
    # Uses: predictive-analytics to predict relevant context
    param(
        [string]$Context,
        [string]$UserIntent
    )

    try {
        Write-Log "Running predictive analytics for context selection" "DEBUG"

        # Predict relevant context parts
        try {
            $predictArgs = @{
                operation = "predict"
                query = $UserIntent
                data = @{
                    context = $Context
                    horizon = 100
                }
            }
            $predictJson = $predictArgs | ConvertTo-Json -Compress -Depth 5
            $predictResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive-analytics" -ArgumentsJson $predictJson

            if ($predictResult) {
                $predictData = $predictResult | ConvertFrom-Json
                if ($predictData -and $predictData.content) {
                    Write-Log "Predicted relevant context segments" "DEBUG"
                    return $predictData.content[0].text
                }
            }
        } catch {
            Write-Log "Predictive analytics failed: $($_.Exception.Message)" "DEBUG"
        }

        return $Context

    } catch {
        Write-Log "PredictiveAnalytics handler failed: $($_.Exception.Message)" "ERROR"
        return $Context
    }
}

function Handle-IntelligentAssistant {
    # PHASE 4: Intelligent assistant orchestration
    # Uses: intelligent-assistant for optimization decisions
    param(
        [string]$Query,
        [hashtable]$Data
    )

    try {
        Write-Log "Consulting intelligent assistant" "DEBUG"

        $assistantArgs = @{
            operation = "ask"
            query = $Query
            data = $Data
        }
        $assistantJson = $assistantArgs | ConvertTo-Json -Compress -Depth 5
        $assistantResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "intelligent-assistant" -ArgumentsJson $assistantJson

        if ($assistantResult) {
            $assistantData = $assistantResult | ConvertFrom-Json
            if ($assistantData -and $assistantData.content) {
                return $assistantData.content[0].text
            }
        }

        return $null

    } catch {
        Write-Log "IntelligentAssistant handler failed: $($_.Exception.Message)" "ERROR"
        return $null
    }
}

function Handle-PreToolUseOptimization {
    param([string]$InputJson)
    # PHASE 3: PreToolUse - Check cache, optimize inputs, avoid redundant calls
    # Uses: get_cached, predictive_cache, optimize_text for inputs
    try {
        if (-not $InputJson) {
            Write-Log "No input received for PreToolUse optimization" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $toolName = if ($data.tool_name) { $data.tool_name } else { "unknown" }
        $toolArgs = if ($data.tool_arguments) { $data.tool_arguments } else { @{} }

        Write-Log "PreToolUse optimization for: $toolName" "DEBUG"

        # Step 1: Check predictive cache for this tool call
        try {
            $cacheKey = "$toolName-$($toolArgs | ConvertTo-Json -Compress -Depth 5)"
            $getCachedArgs = @{
                key = $cacheKey
            }
            $getCachedJson = $getCachedArgs | ConvertTo-Json -Compress
            $cachedResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "get_cached" -ArgumentsJson $getCachedJson

            if ($cachedResult) {
                $cachedData = $cachedResult | ConvertFrom-Json
                if ($cachedData -and $cachedData.content) {
                    Write-Log "Cache HIT for $toolName - avoiding redundant tool call" "INFO"
                    # Return standard block response so dispatcher can exit 2
                    $blockResponse = @{
                        continue = $false
                        stopReason = "cache hit"
                        hookSpecificOutput = @{
                            hookEventName = "PreToolUse"
                            cached = $true
                            toolName = $toolName
                            cachedOutput = $cachedData.content[0].text
                        }
                    } | ConvertTo-Json -Depth 10 -Compress
                    Write-Output $blockResponse
                    [Console]::Out.Flush(); [Console]::Error.Flush()
                    return 2
                }
            }
        } catch {
            # Cache miss is normal, continue
            Write-Log "Cache miss for $toolName" "DEBUG"
        }

        # Step 2: Use predictive cache to predict if this call will be needed
        try {
            $predictArgs = @{
                operation = "predict"
                modelType = "hybrid"
                maxPredictions = 1
                confidence = 0.8
            }
            $predictJson = $predictArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive_cache" -ArgumentsJson $predictJson
        } catch {
            # Optional feature
        }

        # Step 3: Optimize tool input arguments if they contain large text (PHASE 4: Skip < 500 chars)
        $argsJson = $toolArgs | ConvertTo-Json -Depth 10
        if ($toolArgs -and $argsJson.Length -gt 500) {
            try {
                $optimizeArgs = @{
                    text = $argsJson
                    key = "tool_input_${toolName}_$(Get-Date -Format 'yyyyMMddHHmmss')"
                    quality = 7  # PHASE 4: Reduced from 9 to 7 for performance
                }
                $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
                $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson

                if ($optimizeResult) {
                    $optimizeData = $optimizeResult | ConvertFrom-Json
                    if ($optimizeData -and $optimizeData.content) {
                        Write-Log "Optimized input for $toolName" "DEBUG"
                    }
                }
            } catch {
                Write-Log "Input optimization failed: $($_.Exception.Message)" "WARN"
            }
        }

        # Record tool access for predictive caching
        try {
            $recordArgs = @{
                operation = "record-access"
                key = $cacheKey
                timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            }
            $recordJson = $recordArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive_cache" -ArgumentsJson $recordJson
        } catch {
            # Optional feature
        }

    } catch {
        Write-Log "PreToolUse optimization failed: $($_.Exception.Message)" "ERROR"
        return 1
    }
    return 0
}

function Handle-OptimizeToolOutput {
    param([string]$InputJson)
    # PHASE 1: PostToolUse optimization - optimize ALL tool outputs
    # Uses: optimize_text, count_tokens, compress_text, smart_cache
    try {
        if (-not $InputJson) {
            Write-Log "No input received for tool output optimization" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $toolName = $data.tool_name
        $toolOutput = $data.tool_result

        # Skip if no output or if output is already optimized
        if (-not $toolOutput) {
            Write-Log "No tool output to optimize for: $toolName" "DEBUG"
            return
        }

        # Convert output to string for token counting
        $outputText = if ($toolOutput -is [string]) { $toolOutput } else { $toolOutput | ConvertTo-Json -Depth 10 }

        # Count tokens BEFORE optimization
        $beforeTokens = 0
        try {
            $countArgs = @{ text = $outputText }
            $countJson = $countArgs | ConvertTo-Json -Compress
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            $countData = if ($countResult) { $countResult | ConvertFrom-Json } else { $null }
            if ($countData -and $countData.content) {
                $beforeTokens = [int]($countData.content[0].text)
            }
        } catch {
            Write-Log "Token counting failed: $($_.Exception.Message)" "WARN"
        }

        Write-Log "Tool output before optimization: $beforeTokens tokens" "DEBUG"

        # PHASE 4: Skip optimization for small outputs < 500 characters
        if ($outputText.Length -lt 500) {
            Write-Log "Skipping optimization for small output ($($outputText.Length) chars)" "DEBUG"
            return
        }

        # PHASE 7: Apply tool-specific optimization first
        try {
            $specificOptimized = Handle-ToolSpecificOptimization -ToolName $toolName -ToolOutput $outputText
            if ($specificOptimized -and $specificOptimized.Length -lt $outputText.Length) {
                $outputText = $specificOptimized
                Write-Log "Tool-specific optimization applied for $toolName" "DEBUG"
            }
        } catch {
            Write-Log "Tool-specific optimization failed: $($_.Exception.Message)" "WARN"
        }

        # Optimize using optimize_text (PHASE 4: Reduced quality for performance)
        try {
            $optimizeArgs = @{
                text = $outputText
                key = "tool_output_${toolName}_$(Get-Date -Format 'yyyyMMddHHmmss')"
                quality = 7  # PHASE 4: Reduced from 11 to 7 for performance
            }
            $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
            $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson
            $optimizeData = if ($optimizeResult) { $optimizeResult | ConvertFrom-Json } else { $null }

            if ($optimizeData -and $optimizeData.content) {
                $optimizedText = $optimizeData.content[0].text
                $afterTokens = if ($optimizeData.metadata -and $optimizeData.metadata.compressedTokens) {
                    $optimizeData.metadata.compressedTokens
                } else { $beforeTokens }
                $saved = $beforeTokens - $afterTokens
                $percent = if ($beforeTokens -gt 0) { [math]::Round(($saved / $beforeTokens) * 100, 1) } else { 0 }

                Write-Log "Optimized $toolName output: $beforeTokens → $afterTokens tokens ($percent% reduction)" "INFO"

                # Update session tokens
                Update-SessionOperation -TokensDelta $afterTokens
            }
        } catch {
            Write-Log "Tool output optimization failed: $($_.Exception.Message)" "ERROR"
        }

    } catch {
        Write-Log "OptimizeToolOutput handler failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-PreCompactOptimization {
    param([string]$InputJson)
    # PHASE 1: PreCompact aggressive context reduction
    # Uses: optimize_text, compress_text, count_tokens, smart_summarization
    try {
        if (-not $InputJson) {
            Write-Log "No input received for PreCompact optimization" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $contextText = if ($data.context) { $data.context } else { "" }

        if (-not $contextText) {
            Write-Log "No context to optimize in PreCompact" "DEBUG"
            return
        }

        Write-Log "Starting PreCompact aggressive optimization" "INFO"

        # Step 1: Count tokens BEFORE
        $beforeTokens = 0
        try {
            $countArgs = @{ text = $contextText }
            $countJson = $countArgs | ConvertTo-Json -Compress
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            $countData = if ($countResult) { $countResult | ConvertFrom-Json } else { $null }
            if ($countData -and $countData.content) {
                $beforeTokens = [int]($countData.content[0].text)
            }
        } catch {
            Write-Log "PreCompact token counting failed: $($_.Exception.Message)" "WARN"
        }

        Write-Log "Context before PreCompact: $beforeTokens tokens" "INFO"

        # PHASE 4: Apply intelligent summarization for large contexts
        if ($beforeTokens -gt 5000) {
            try {
                $summarized = Handle-IntelligentSummarization -Text $contextText -Context "precompact"
                if ($summarized -and $summarized.Length -lt $contextText.Length) {
                    $contextText = $summarized
                    Write-Log "After intelligent summarization: reduced from $($contextText.Length) chars" "INFO"
                }
            } catch {
                Write-Log "Intelligent summarization failed: $($_.Exception.Message)" "WARN"
            }
        }

        # PHASE 4: Pattern recognition to abstract recurring data
        try {
            $patterns = Handle-PatternRecognition -Text $contextText
            if ($patterns) {
                Write-Log "Patterns identified for abstraction" "DEBUG"
            }
        } catch {
            # Optional feature
        }

        # Step 2: Apply optimize_text (aggressive mode, PHASE 4: Reduced quality)
        $optimizedContext = $contextText
        try {
            $optimizeArgs = @{
                text = $contextText
                key = "precompact_context_$(Get-Date -Format 'yyyyMMddHHmmss')"
                quality = 7  # PHASE 4: Reduced from 11 to 7 for performance
            }
            $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
            $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson
            $optimizeData = if ($optimizeResult) { $optimizeResult | ConvertFrom-Json } else { $null }

            if ($optimizeData -and $optimizeData.content) {
                $optimizedContext = $optimizeData.content[0].text
                Write-Log "After optimize_text: $($optimizeData.metadata.compressedTokens) tokens" "DEBUG"
            }
        } catch {
            Write-Log "PreCompact optimize_text failed: $($_.Exception.Message)" "ERROR"
        }

        # Step 3: Apply compress_text if still over threshold (PHASE 4: Reduced quality)
        if ($beforeTokens -gt ($CONTEXT_LIMIT * $OPTIMIZE_THRESHOLD)) {
            try {
                $compressArgs = @{
                    text = $optimizedContext
                    quality = 7  # PHASE 4: Reduced from 11 to 7 for performance
                }
                $compressJson = $compressArgs | ConvertTo-Json -Compress
                $compressResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "compress_text" -ArgumentsJson $compressJson
                $compressData = if ($compressResult) { $compressResult | ConvertFrom-Json } else { $null }

                if ($compressData -and $compressData.content) {
                    $optimizedContext = $compressData.content[0].text
                    Write-Log "After compress_text: compressed" "DEBUG"
                }
            } catch {
                Write-Log "PreCompact compress_text failed: $($_.Exception.Message)" "ERROR"
            }
        }

        # Step 4: Count tokens AFTER
        $afterTokens = 0
        try {
            $countArgs = @{ text = $optimizedContext }
            $countJson = $countArgs | ConvertTo-Json -Compress
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            $countData = if ($countResult) { $countResult | ConvertFrom-Json } else { $null }
            if ($countData -and $countData.content) {
                $afterTokens = [int]($countData.content[0].text)
            }
        } catch {
            Write-Log "PreCompact final token counting failed: $($_.Exception.Message)" "WARN"
        }

        $saved = $beforeTokens - $afterTokens
        $percent = if ($beforeTokens -gt 0) { [math]::Round(($saved / $beforeTokens) * 100, 1) } else { 0 }

        Write-Log "PreCompact optimization complete: $beforeTokens → $afterTokens tokens ($percent% reduction, saved $saved tokens)" "INFO"

        # Output optimized context (if hooks support returning modified context)
        $result = @{
            optimizedContext = $optimizedContext
            beforeTokens = $beforeTokens
            afterTokens = $afterTokens
            tokensSaved = $saved
            reductionPercent = $percent
        } | ConvertTo-Json -Depth 10 -Compress

        Write-Output $result

    } catch {
        Write-Log "PreCompact optimization handler failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-SmartRead {
    param([string]$InputJson)
    # Use smart_read MCP tool for intelligent file reading with built-in caching
    # This replaces plain Read with cache-aware, diff-based, truncated reading
    try {
        if (-not $InputJson) {
            Write-Log "No input received for smart-read" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $toolName = $data.tool_name

        # Intercept Read, mcp__filesystem__read_file, and mcp__filesystem__read_text_file
        if ($toolName -notin @("Read", "mcp__filesystem__read_file", "mcp__filesystem__read_text_file")) {
            return
        }

        # Extract file path (different field names for different tools)
        $filePath = $data.tool_input.file_path
        if (-not $filePath) {
            $filePath = $data.tool_input.path
        }
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
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_read" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        # Check for errors - if MCP call failed, allow fallback to plain Read
        if ($result -and $result.isError) {
            Write-Log "smart_read returned error: $($result.content[0].text)" "WARN"
            return
        }

        if ($result -and $result.content) {
            # SUCCESS - Block plain Read and return smart_read result
            # PHASE 1 FIX: Add debug logging and null-safe metadata parsing
            Write-Log "smart_read raw result: $($resultJson | Out-String)" "DEBUG"

            $fromCache = if ($result.metadata -and $result.metadata.fromCache) { "CACHE HIT" } else { "NEW READ" }
            $isDiff = if ($result.metadata -and $result.metadata.isDiff) { "DIFF" } else { "FULL" }
            $tokens = if ($result.metadata -and $result.metadata.tokenCount) { $result.metadata.tokenCount } else { "unknown" }
            $tokensSaved = if ($result.metadata -and $result.metadata.tokensSaved) { $result.metadata.tokensSaved } else { 0 }

            Write-Log "$fromCache - ${isDiff}: $filePath ($tokens tokens, saved $tokensSaved)" "INFO"

            # FIX: Update session tokens with the tokens from smart_read
            if ($tokens -ne "unknown") {
                Update-SessionOperation -TokensDelta $tokens
                Write-Log "Updated session totalTokens by $tokens" "DEBUG"
            }

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
            # PHASE 1 FIX: Flush output before exit to prevent freezing
            [Console]::Out.Flush()
            [Console]::Error.Flush()
            return 2  # BUGFIX: Return instead of exit to avoid terminating dispatcher

        } else {
            # FAILED - Allow plain Read to proceed
            Write-Log "smart_read failed for $filePath - falling back to plain Read" "WARN"
            return 0
        }

    } catch {
        Write-Log "smart_read failed: $($_.Exception.Message)" "ERROR"
        # On error, allow plain Read to proceed
        return 0
    }
}

# Main execution - Only run if script is executed directly (not dot-sourced)
# When dot-sourced by dispatcher.ps1, this block is skipped and only functions are loaded
if ($MyInvocation.InvocationName -ne '.') {
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
            "optimize-tool-output" {
                Handle-OptimizeToolOutput
            }
            "precompact-optimize" {
                Handle-PreCompactOptimization
            }
            "user-prompt-optimize" {
                Handle-UserPromptOptimization
            }
            "session-start-init" {
                Handle-SessionStartInit
            }
            "pretooluse-optimize" {
                Handle-PreToolUseOptimization
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
}
