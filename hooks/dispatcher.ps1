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

    # DEBUG: Log raw stdin length and first 100 chars
    Write-Log "DEBUG: stdin length=$($input_json.Length), preview=$($input_json.Substring(0, [Math]::Min(100, $input_json.Length)))"

    $data = $input_json | ConvertFrom-Json
    $toolName = $data.tool_name

    Write-Log "Tool: $toolName"

    # Write JSON to temp file to avoid command-line length limits
    $tempFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "hook-input-$([guid]::NewGuid().ToString()).json")
    [System.IO.File]::WriteAllText($tempFile, $input_json, [System.Text.Encoding]::UTF8)

    # ============================================================
    # PHASE: PreToolUse
    # ============================================================
    if ($Phase -eq "PreToolUse") {

        # 1. SMART READ - Use smart_read MCP tool for cached file reads (CRITICAL FOR TOKEN SAVINGS!)
        # This replaces plain Read with intelligent caching, diffing, and truncation
        # Must run BEFORE user enforcers to ensure caching takes priority
        if ($toolName -eq "Read") {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreToolUse" -Action "smart-read" -InputJsonFile $tempFile
            if ($LASTEXITCODE -eq 2) {
                # smart_read succeeded - blocks plain Read and returns cached/optimized content
                exit 2
            }
            # If smart_read failed, allow plain Read to proceed
        }

        # 2. Context Guard - Check if we're approaching token limit
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreToolUse" -Action "context-guard" -InputJsonFile $tempFile
        if ($LASTEXITCODE -eq 2) {
            Block-Tool -Reason "Context budget exhausted - session optimization required"
        }

        # 3. Track operation
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreToolUse" -Action "session-track" -InputJsonFile $tempFile

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
            # DISABLED: MCP tools not available, allow gh CLI
            # Block-Tool -Reason "Use GitHub MCP (mcp__github__*) for GitHub operations (pr, issue, etc.)"
            Write-Log "[ALLOW] GitHub operation via gh CLI: $($data.tool_input.command)"
            exit 0
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

        # Cleanup temp file before exit
        if (Test-Path $tempFile) {
            Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
        }

        exit 0
    }

    # ============================================================
    # PHASE: PostToolUse
    # ============================================================
    if ($Phase -eq "PostToolUse") {
        $phaseStart = Get-Date

        # 1. Log ALL tool operations to operations-{sessionId}.csv
        #    This is CRITICAL for session-level optimization
        $actionStart = Get-Date
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PostToolUse" -Action "log-operation" -InputJsonFile $tempFile
        $actionDuration = ((Get-Date) - $actionStart).TotalMilliseconds
        Write-Log "TIMING: log-operation took ${actionDuration}ms"

        # 2. Optimize tool output for token savings (BACKGROUND MODE - NON-BLOCKING)
        #    Run in background process to avoid blocking the main thread
        #    This allows hooks to return immediately while optimization runs async
        $actionStart = Get-Date
        Write-Log "BACKGROUND: Starting optimize-tool-output in background process"
        Start-Process -FilePath "powershell" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$ORCHESTRATOR,"-Phase","PostToolUse","-Action","optimize-tool-output","-InputJsonFile",$tempFile -WindowStyle Hidden
        $actionDuration = ((Get-Date) - $actionStart).TotalMilliseconds
        Write-Log "TIMING: optimize-tool-output background spawn took ${actionDuration}ms"

        # 3. Track operation count
        $actionStart = Get-Date
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PostToolUse" -Action "session-track" -InputJsonFile $tempFile
        $actionDuration = ((Get-Date) - $actionStart).TotalMilliseconds
        Write-Log "TIMING: session-track took ${actionDuration}ms"

        $phaseDuration = ((Get-Date) - $phaseStart).TotalMilliseconds
        Write-Log "TIMING: PostToolUse total took ${phaseDuration}ms"

        # NOTE: Do NOT cleanup temp file here - background process needs it
        # Background process will clean up when done

        exit 0
    }

    # ============================================================
    # PHASE: SessionStart
    # ============================================================
    if ($Phase -eq "SessionStart") {

        Write-Log "Session starting - warming cache"

        # Pre-warm cache using predictive patterns
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "SessionStart" -Action "cache-warmup" -InputJsonFile $tempFile

        # Cleanup temp file
        if (Test-Path $tempFile) {
            Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
        }

        exit 0
    }

    # ============================================================
    # PHASE: PreCompact
    # ============================================================
    if ($Phase -eq "PreCompact") {

        Write-Log "Session ending - generating final report"

        # Generate comprehensive session analytics
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "PreCompact" -Action "session-report" -InputJsonFile $tempFile

        # Cleanup temp file
        if (Test-Path $tempFile) {
            Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
        }

        exit 0
    }

    # ============================================================
    # PHASE: UserPromptSubmit
    # ============================================================
    if ($Phase -eq "UserPromptSubmit") {
        # Track user prompts for analytics
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "UserPromptSubmit" -Action "session-track" -InputJsonFile $tempFile

        # CRITICAL: Run session-level optimization at end of user turn
        # This batch-optimizes ALL file operations from the previous turn
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ORCHESTRATOR -Phase "UserPromptSubmit" -Action "optimize-session" -InputJsonFile $tempFile

        # Cleanup temp file
        if (Test-Path $tempFile) {
            Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
        }

        exit 0
    }

    # Unknown phase
    Write-Log "Unknown phase: $Phase"

    # Cleanup temp file
    if (Test-Path $tempFile) {
        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    }

    exit 0

} catch {
    Write-Log "[ERROR] Dispatcher failed: $($_.Exception.Message)"

    # Cleanup temp file on error
    if ($tempFile -and (Test-Path $tempFile)) {
        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    }

    exit 0  # Never block on error
}
