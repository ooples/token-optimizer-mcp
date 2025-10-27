# Claude Code Hooks Dispatcher - Token Optimizer Edition
# Minimal dispatcher focused on token optimization via MCP
# Replaces 400+ line mess with clean architecture

param([string]$Phase = "")

$HANDLERS_DIR = "C:\Users\cheat\.claude-global\hooks\handlers"
$LOG_FILE = "C:\Users\cheat\.claude-global\hooks\logs\dispatcher.log"
$ORCHESTRATOR = "$HANDLERS_DIR\token-optimizer-orchestrator.ps1"

# PERFORMANCE FIX: Prefer local dev path if not already set
if (-not $env:TOKEN_OPTIMIZER_DEV_PATH) {
  $env:TOKEN_OPTIMIZER_DEV_PATH = "C:\Users\cheat\source\repos\token-optimizer-mcp"
}

# CRITICAL PERFORMANCE FIX: Dot-source orchestrator to avoid creating new PowerShell process for every action
# This eliminates 90%+ of hook overhead by loading functions once instead of spawning processes
. "$HANDLERS_DIR\token-optimizer-orchestrator.ps1"

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('DEBUG','INFO','WARN','ERROR')][string]$Level = 'INFO'
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] [$Level] [$Phase] $Message" | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8
}

function Block-Tool {
    param([string]$Reason)

    Write-Log "[BLOCK] $Reason"

    $blockResponse = @{
        continue = $false
        stopReason = $Reason
        hookSpecificOutput = @{
            hookEventName = $Phase
            permissionDecision = "deny"
            permissionDecisionReason = $Reason
        }
    } | ConvertTo-Json -Depth 10 -Compress

    Write-Output $blockResponse
    exit 2
}

try {
    # DIAGNOSTIC: Log that dispatcher was invoked at all
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[DEBUG] [$timestamp] [$Phase] DISPATCHER INVOKED" | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8

    # Read JSON input from stdin
    # NOTE: [Console]::In.ReadToEnd() works fine on Windows - the UTF-8 byte stream approach BROKE it!
    try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    $input_json = [Console]::In.ReadToEnd()

    # DEBUG: Log raw JSON to see what we're receiving
    "[DEBUG] [$timestamp] RAW JSON: $($input_json.Substring(0, [Math]::Min(200, $input_json.Length)))" | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8

    if (-not $input_json) {
        Write-Log "No JSON input"
        exit 0
    }

    $data = $input_json | ConvertFrom-Json
    $toolName = $data.tool_name

    Write-Log "Tool: $toolName"
    "[DEBUG] [$timestamp] TOOL NAME: $toolName" | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8

    # ============================================================
    # PHASE: PreToolUse
    # ============================================================
    if ($Phase -eq "PreToolUse") {

        # 1. SMART READ - Use smart_read MCP tool for cached file reads (CRITICAL FOR TOKEN SAVINGS!)
        # This replaces plain Read with intelligent caching, diffing, and truncation
        # Must run BEFORE user enforcers to ensure caching takes priority
        # Match: Read, mcp__filesystem__read_file, mcp__filesystem__read_text_file
        if ($toolName -eq "Read" -or $toolName -eq "mcp__filesystem__read_file" -or $toolName -eq "mcp__filesystem__read_text_file") {
            "[DEBUG] [$timestamp] MATCHED READ TOOL: $toolName" | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8
            $startTime = Get-Date
            $smartReadResult = Handle-SmartRead -InputJson $input_json
            $duration = ((Get-Date) - $startTime).TotalMilliseconds
            Write-Log "[PERF] smart-read took $([math]::Round($duration, 2))ms" "DEBUG"
            if ($smartReadResult -eq 2) {
                # smart_read succeeded - blocks plain Read and returns cached/optimized content
                exit 2
            }
            # If smart_read failed, allow plain Read to proceed
        }

        # 2. Context Guard - Check if we're approaching token limit
        $startTime = Get-Date
        $guardResult = Handle-ContextGuard -InputJson $input_json
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] context-guard took $([math]::Round($duration, 2))ms" "DEBUG"
        if ($guardResult -eq 2) {
            Block-Tool -Reason "Context budget exhausted - session optimization required"
        }

        # 3. Track operation
        $session = Update-SessionOperation
        Write-Log "Operation #$($session.totalOperations)" "DEBUG"

        # NOTE: pretooluse-optimize is DISABLED due to PowerShell/Node.js stdin EOF handling bug
        # causing 60+ second hangs on every MCP call. Will re-enable after fixing invoke-mcp.ps1
        # $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreToolUse" -Action "pretooluse-optimize"

        # 4. MCP Enforcers - Force usage of MCP tools over Bash/Read/Grep

        # Git MCP Enforcer - Allow local operations, enforce MCP for remote operations
        if ($toolName -eq "Bash" -and $data.tool_input.command -match "git\s") {
            # Allow local git operations that GitHub MCP cannot perform
            $localGitOps = @(
                "git\s+status",           # Check working directory status
                "git\s+branch",           # List/create/delete branches
                "git\s+checkout",         # Switch branches
                "git\s+worktree",         # Manage worktrees (critical for agent coordination)
                "git\s+add",              # Stage files
                "git\s+commit",           # Create commits
                "git\s+diff",             # Show changes
                "git\s+log",              # View history
                "git\s+stash",            # Stash changes
                "git\s+pull",             # Pull from remote
                "git\s+push",             # Push to remote (includes -u flag)
                "git\s+fetch",            # Fetch from remote
                "git\s+remote",           # Manage remotes
                "git\s+rev-parse",        # Parse git objects
                "git\s+config",           # Git configuration
                "git\s+merge",            # Merge operations (includes --abort)
                "git\s+reset",            # Reset operations
                "git\s+clean"             # Clean working directory
            )

            $isLocalOp = $false
            foreach ($pattern in $localGitOps) {
                if ($data.tool_input.command -match $pattern) {
                    $isLocalOp = $true
                    break
                }
            }

            if ($isLocalOp) {
                Write-Log "[ALLOW] Local git operation: $($data.tool_input.command)"
                exit 0
            }

            # Block GitHub operations - require MCP
            Block-Tool -Reason "Use GitHub MCP (mcp__github__*) for GitHub operations (pr, issue, etc.)"
        }

        # Gemini CLI Enforcer - Now safe to enable because smart_read runs first
        # if ($toolName -in @("Read", "Grep")) {
        #     $path = $data.tool_input.file_path
        #     if (-not $path) { $path = $data.tool_input.path }
        #
        #     if ($path -and $path -match "\.(ts|tsx|js|jsx|py|java|cpp|c|h|cs|go|rs|rb|php)$") {
        #         Block-Tool -Reason "Use Gemini CLI (gemini -m gemini-2.5-flash) for code analysis instead of $toolName"
        #     }
        # }

        # PHASE 3: Check cache, optimize inputs, avoid redundant tool calls
        $startTime = Get-Date
        Handle-PreToolUseOptimization -InputJson $input_json
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] pretooluse-optimize took $([math]::Round($duration, 2))ms" "DEBUG"

        Write-Log "[ALLOW] $toolName"
        exit 0
    }

    # ============================================================
    # PHASE: PostToolUse
    # ============================================================
    if ($Phase -eq "PostToolUse") {

        # 1. PHASE 1 & 7: Optimize ALL tool outputs (tool-specific + general)
        #    Uses optimize_text, count_tokens, compress_text, tool-specific handlers
        $startTime = Get-Date
        Handle-OptimizeToolOutput -InputJson $input_json
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] optimize-tool-output took $([math]::Round($duration, 2))ms" "DEBUG"

        # 2. Log ALL tool operations to operations-{sessionId}.csv
        #    This is CRITICAL for session-level optimization
        $startTime = Get-Date
        Handle-LogOperation -InputJson $input_json
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] log-operation took $([math]::Round($duration, 2))ms" "DEBUG"

        # 3. Track operation count
        $session = Update-SessionOperation
        Write-Log "Operation #$($session.totalOperations)" "DEBUG"

        exit 0
    }

    # ============================================================
    # PHASE: SessionStart
    # ============================================================
    if ($Phase -eq "SessionStart") {

        Write-Log "Session starting - Phase 2 initialization"

        # PHASE 2: Initialize session with cache warmup, health checks, monitoring
        $startTime = Get-Date
        Handle-SessionStartInit
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] session-start-init took $([math]::Round($duration, 2))ms" "DEBUG"

        exit 0
    }

    # ============================================================
    # PHASE: PreCompact
    # ============================================================
    if ($Phase -eq "PreCompact") {

        Write-Log "Session ending - running PreCompact optimization"

        # PHASE 1: Aggressive context optimization BEFORE compaction
        # Uses optimize_text, compress_text, count_tokens to achieve 60-80% token reduction
        $startTime = Get-Date
        Handle-PreCompactOptimization -InputJson $input_json
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] precompact-optimize took $([math]::Round($duration, 2))ms" "DEBUG"

        # Generate comprehensive session analytics
        $startTime = Get-Date
        Handle-SessionReport
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] session-report took $([math]::Round($duration, 2))ms" "DEBUG"

        exit 0
    }

    # ============================================================
    # PHASE: UserPromptSubmit
    # ============================================================
    if ($Phase -eq "UserPromptSubmit") {
        # PHASE 2: Optimize user prompt before processing
        $startTime = Get-Date
        Handle-UserPromptOptimization -InputJson $input_json
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] user-prompt-optimize took $([math]::Round($duration, 2))ms" "DEBUG"

        # Track user prompts for analytics
        $session = Update-SessionOperation
        Write-Log "Operation #$($session.totalOperations)" "DEBUG"

        # CRITICAL: Run session-level optimization at end of user turn
        # This batch-optimizes ALL file operations from the previous turn
        $startTime = Get-Date
        Handle-OptimizeSession
        $duration = ((Get-Date) - $startTime).TotalMilliseconds
        Write-Log "[PERF] optimize-session took $([math]::Round($duration, 2))ms" "DEBUG"

        exit 0
    }

    # Unknown phase
    Write-Log "Unknown phase: $Phase"
    exit 0

} catch {
    Write-Log "[ERROR] Dispatcher failed: $($_.Exception.Message)"
    exit 0  # Never block on error
}
