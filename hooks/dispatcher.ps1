# Claude Code Hooks Dispatcher - Token Optimizer Edition
# Minimal dispatcher focused on token optimization via MCP
# Replaces 400+ line mess with clean architecture

param([string]$Phase = "")

$HANDLERS_DIR = "C:\Users\cheat\.claude-global\hooks\handlers"
$LOG_FILE = "C:\Users\cheat\.claude-global\hooks\logs\dispatcher.log"
$ORCHESTRATOR = "$HANDLERS_DIR\token-optimizer-orchestrator.ps1"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] [$Phase] $Message" | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8
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
    # Read JSON input from stdin
    $input_json = [Console]::In.ReadToEnd()

    if (-not $input_json) {
        Write-Log "No JSON input"
        exit 0
    }

    $data = $input_json | ConvertFrom-Json
    $toolName = $data.tool_name

    Write-Log "Tool: $toolName"

    # ============================================================
    # PHASE: PreToolUse
    # ============================================================
    if ($Phase -eq "PreToolUse") {

        # 1. SMART READ - Use smart_read MCP tool for cached file reads (CRITICAL FOR TOKEN SAVINGS!)
        # This replaces plain Read with intelligent caching, diffing, and truncation
        # Must run BEFORE user enforcers to ensure caching takes priority
        if ($toolName -eq "Read") {
            $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreToolUse" -Action "smart-read"
            if ($LASTEXITCODE -eq 2) {
                # smart_read succeeded - blocks plain Read and returns cached/optimized content
                exit 2
            }
            # If smart_read failed, allow plain Read to proceed
        }

        # 2. Context Guard - Check if we're approaching token limit
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreToolUse" -Action "context-guard"
        if ($LASTEXITCODE -eq 2) {
            Block-Tool -Reason "Context budget exhausted - session optimization required"
        }

        # 3. Track operation
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreToolUse" -Action "session-track"

        # 4. MCP Enforcers - Force usage of MCP tools over Bash/Read/Grep

        # Git MCP Enforcer
        if ($toolName -eq "Bash" -and $data.tool_input.command -match "git\s") {
            Block-Tool -Reason "Use GitHub MCP (mcp__github__*) instead of git CLI commands"
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

        Write-Log "[ALLOW] $toolName"
        exit 0
    }

    # ============================================================
    # PHASE: PostToolUse
    # ============================================================
    if ($Phase -eq "PostToolUse") {

        # 1. Log ALL tool operations to operations-{sessionId}.csv
        #    This is CRITICAL for session-level optimization
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PostToolUse" -Action "log-operation"

        # 2. Track operation count
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PostToolUse" -Action "session-track"

        exit 0
    }

    # ============================================================
    # PHASE: SessionStart
    # ============================================================
    if ($Phase -eq "SessionStart") {

        Write-Log "Session starting - warming cache"

        # Pre-warm cache using predictive patterns
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "SessionStart" -Action "cache-warmup"

        exit 0
    }

    # ============================================================
    # PHASE: PreCompact
    # ============================================================
    if ($Phase -eq "PreCompact") {

        Write-Log "Session ending - generating final report"

        # Generate comprehensive session analytics
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreCompact" -Action "session-report"

        exit 0
    }

    # ============================================================
    # PHASE: UserPromptSubmit
    # ============================================================
    if ($Phase -eq "UserPromptSubmit") {
        # Track user prompts for analytics
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "UserPromptSubmit" -Action "session-track"

        # CRITICAL: Run session-level optimization at end of user turn
        # This batch-optimizes ALL file operations from the previous turn
        $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "UserPromptSubmit" -Action "optimize-session"

        exit 0
    }

    # Unknown phase
    Write-Log "Unknown phase: $Phase"
    exit 0

} catch {
    Write-Log "[ERROR] Dispatcher failed: $($_.Exception.Message)"
    exit 0  # Never block on error
}
