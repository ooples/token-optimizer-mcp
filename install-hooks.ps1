# Token Optimizer MCP - Automated Hooks Installer
# Installs global Claude Code hooks for automatic token optimization

param(
    [switch]$Force,           # Force reinstall even if already installed
    [switch]$SkipMCPCheck,    # Skip MCP server installation check
    [switch]$DryRun           # Preview changes without applying
)

$ErrorActionPreference = "Stop"

# ============================================================
# Configuration
# ============================================================

$HOOKS_DIR = "$env:USERPROFILE\.claude-global\hooks"
$CLAUDE_SETTINGS = "$env:USERPROFILE\.claude\settings.json"
$CLAUDE_STATE = "$env:USERPROFILE\.claude.json"
$MCP_CONFIG = "$env:APPDATA\Claude\claude_desktop_config.json"

$REPO_URL = "https://raw.githubusercontent.com/ooples/token-optimizer-mcp/main/hooks"

# ============================================================
# Helper Functions
# ============================================================

function Write-Status {
    param([string]$Message, [string]$Type = "INFO")

    $color = switch ($Type) {
        "SUCCESS" { "Green" }
        "ERROR" { "Red" }
        "WARN" { "Yellow" }
        default { "Cyan" }
    }

    Write-Host "[$Type] $Message" -ForegroundColor $color
}

function Test-Prerequisites {
    Write-Status "Checking prerequisites..." "INFO"

    # Check PowerShell version
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required. Current version: $($PSVersionTable.PSVersion)"
    }
    Write-Status "✓ PowerShell version: $($PSVersionTable.PSVersion)" "SUCCESS"

    # Check Claude Code is installed
    try {
        $claudeVersion = & claude --version 2>&1
        Write-Status "✓ Claude Code installed: $claudeVersion" "SUCCESS"
    } catch {
        throw "Claude Code CLI not found. Install from: https://docs.claude.com/en/docs/claude-code"
    }

    # Check execution policy
    $policy = Get-ExecutionPolicy
    if ($policy -eq "Restricted") {
        Write-Status "PowerShell execution policy is Restricted" "WARN"
        Write-Status "Setting execution policy to RemoteSigned..." "INFO"
        Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
        Write-Status "✓ Execution policy updated" "SUCCESS"
    } else {
        Write-Status "✓ Execution policy: $policy" "SUCCESS"
    }

    # Check token-optimizer-mcp is installed (optional)
    if (-not $SkipMCPCheck) {
        $mcpPath = "$env:APPDATA\npm\node_modules\@ooples\token-optimizer-mcp"
        if (-not (Test-Path $mcpPath)) {
            Write-Status "token-optimizer-mcp not found" "WARN"
            Write-Status "Install with: npm install -g @ooples/token-optimizer-mcp" "INFO"

            $response = Read-Host "Install token-optimizer-mcp now? (y/n)"
            if ($response -eq "y") {
                npm install -g @ooples/token-optimizer-mcp
                Write-Status "✓ token-optimizer-mcp installed" "SUCCESS"
            } else {
                throw "token-optimizer-mcp is required for hooks to work"
            }
        } else {
            Write-Status "✓ token-optimizer-mcp found" "SUCCESS"
        }
    }
}

function Install-HooksFiles {
    Write-Status "Installing hooks files..." "INFO"

    # Create hooks directory
    if (-not (Test-Path $HOOKS_DIR)) {
        New-Item -ItemType Directory -Path $HOOKS_DIR -Force | Out-Null
        Write-Status "✓ Created hooks directory: $HOOKS_DIR" "SUCCESS"
    }

    # Create subdirectories
    @("handlers", "helpers", "logs", "data") | ForEach-Object {
        $dir = Join-Path $HOOKS_DIR $_
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }

    if ($DryRun) {
        Write-Status "[DRY RUN] Would download hooks files from $REPO_URL" "INFO"
        return
    }

    # Download hooks files
    $files = @(
        @{ Source = "$REPO_URL/dispatcher.ps1"; Dest = "$HOOKS_DIR\dispatcher.ps1" },
        @{ Source = "$REPO_URL/handlers/token-optimizer-orchestrator.ps1"; Dest = "$HOOKS_DIR\handlers\token-optimizer-orchestrator.ps1" },
        @{ Source = "$REPO_URL/helpers/invoke-mcp.ps1"; Dest = "$HOOKS_DIR\helpers\invoke-mcp.ps1" }
    )

    foreach ($file in $files) {
        try {
            Write-Status "Downloading: $($file.Source)" "INFO"
            Invoke-WebRequest -Uri $file.Source -OutFile $file.Dest -UseBasicParsing
            Write-Status "✓ Downloaded: $(Split-Path $file.Dest -Leaf)" "SUCCESS"
        } catch {
            Write-Status "⚠ Failed to download $($file.Source): $($_.Exception.Message)" "ERROR"
            Write-Status "Using local package files instead..." "INFO"

            # Fallback: Copy from npm package
            $npmPath = "$env:APPDATA\npm\node_modules\@ooples\token-optimizer-mcp\hooks"
            if (Test-Path $npmPath) {
                Copy-Item -Path "$npmPath\*" -Destination $HOOKS_DIR -Recurse -Force
                Write-Status "✓ Copied hooks from npm package" "SUCCESS"
            } else {
                throw "Could not download hooks and npm package not found"
            }
        }
    }
}

function Configure-ClaudeSettings {
    Write-Status "Configuring Claude Code settings..." "INFO"

    # Backup existing settings
    if (Test-Path $CLAUDE_SETTINGS) {
        $backup = "$CLAUDE_SETTINGS.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $CLAUDE_SETTINGS $backup
        Write-Status "✓ Backed up existing settings to: $backup" "SUCCESS"
    }

    # Create or update settings.json
    $settings = if (Test-Path $CLAUDE_SETTINGS) {
        Get-Content $CLAUDE_SETTINGS -Raw | ConvertFrom-Json
    } else {
        @{}
    }

    # Add hooks configuration
    $hookCommand = "powershell.exe -File $HOOKS_DIR\dispatcher.ps1 -Phase"

    $settings.hooks = @{
        PreToolUse = @(
            @{
                matcher = "*"
                hooks = @(
                    @{
                        type = "command"
                        command = "$hookCommand PreToolUse"
                    }
                )
            }
        )
        PostToolUse = @(
            @{
                matcher = "*"
                hooks = @(
                    @{
                        type = "command"
                        command = "$hookCommand PostToolUse"
                    }
                )
            }
        )
        UserPromptSubmit = @(
            @{
                matcher = "*"
                hooks = @(
                    @{
                        type = "command"
                        command = "$hookCommand UserPromptSubmit"
                    }
                )
            }
        )
        PreCompact = @(
            @{
                matcher = "*"
                hooks = @(
                    @{
                        type = "command"
                        command = "$hookCommand PreCompact"
                    }
                )
            }
        )
    }

    if ($DryRun) {
        Write-Status "[DRY RUN] Would write hooks configuration to: $CLAUDE_SETTINGS" "INFO"
        Write-Status ($settings | ConvertTo-Json -Depth 10) "INFO"
        return
    }

    # Save settings
    $settings | ConvertTo-Json -Depth 10 | Set-Content $CLAUDE_SETTINGS -Encoding UTF8
    Write-Status "✓ Updated Claude Code settings" "SUCCESS"
}

function Configure-WorkspaceTrust {
    Write-Status "Configuring workspace trust..." "INFO"

    $currentDir = (Get-Location).Path

    if (-not (Test-Path $CLAUDE_STATE)) {
        Write-Status "No .claude.json found - trust will be prompted on first run" "WARN"
        return
    }

    # Backup existing state
    $backup = "$CLAUDE_STATE.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $CLAUDE_STATE $backup

    # Read and update state
    $state = Get-Content $CLAUDE_STATE -Raw | ConvertFrom-Json

    # Ensure projects object exists
    if (-not $state.projects) {
        $state | Add-Member -NotePropertyName "projects" -NotePropertyValue @{} -Force
    }

    # Add/update current directory trust
    if (-not $state.projects.$currentDir) {
        $state.projects | Add-Member -NotePropertyName $currentDir -NotePropertyValue @{} -Force
    }

    $state.projects.$currentDir | Add-Member -NotePropertyName "hasTrustDialogAccepted" -NotePropertyValue $true -Force

    if ($DryRun) {
        Write-Status "[DRY RUN] Would accept workspace trust for: $currentDir" "INFO"
        return
    }

    # Save state
    $state | ConvertTo-Json -Depth 100 | Set-Content $CLAUDE_STATE -Encoding UTF8
    Write-Status "✓ Accepted workspace trust for: $currentDir" "SUCCESS"
}

function Configure-MCPServer {
    Write-Status "Configuring MCP server..." "INFO"

    if (-not (Test-Path $MCP_CONFIG)) {
        Write-Status "Creating MCP server configuration..." "INFO"
        $mcpSettings = @{
            mcpServers = @{}
        }
    } else {
        $mcpSettings = Get-Content $MCP_CONFIG -Raw | ConvertFrom-Json
    }

    # Add token-optimizer MCP server
    $mcpPath = "$env:APPDATA\npm\node_modules\@ooples\token-optimizer-mcp\dist\index.js"

    $mcpSettings.mcpServers."token-optimizer" = @{
        type = "stdio"
        command = "node"
        args = @($mcpPath)
        env = @{}
    }

    if ($DryRun) {
        Write-Status "[DRY RUN] Would configure MCP server in: $MCP_CONFIG" "INFO"
        return
    }

    # Ensure directory exists
    $mcpDir = Split-Path $MCP_CONFIG
    if (-not (Test-Path $mcpDir)) {
        New-Item -ItemType Directory -Path $mcpDir -Force | Out-Null
    }

    # Save MCP config
    $mcpSettings | ConvertTo-Json -Depth 10 | Set-Content $MCP_CONFIG -Encoding UTF8
    Write-Status "✓ Configured token-optimizer MCP server" "SUCCESS"
}

function Test-Installation {
    Write-Status "Verifying installation..." "INFO"

    $issues = @()

    # Check hooks files exist
    $requiredFiles = @(
        "$HOOKS_DIR\dispatcher.ps1",
        "$HOOKS_DIR\handlers\token-optimizer-orchestrator.ps1",
        "$HOOKS_DIR\helpers\invoke-mcp.ps1"
    )

    foreach ($file in $requiredFiles) {
        if (-not (Test-Path $file)) {
            $issues += "Missing file: $file"
        }
    }

    # Check settings.json has hooks
    if (Test-Path $CLAUDE_SETTINGS) {
        $settings = Get-Content $CLAUDE_SETTINGS -Raw | ConvertFrom-Json
        if (-not $settings.hooks) {
            $issues += "Hooks not configured in settings.json"
        }
    } else {
        $issues += "Settings.json not found"
    }

    # Check MCP server configured
    if (Test-Path $MCP_CONFIG) {
        $mcpSettings = Get-Content $MCP_CONFIG -Raw | ConvertFrom-Json
        if (-not $mcpSettings.mcpServers."token-optimizer") {
            $issues += "token-optimizer MCP server not configured"
        }
    } else {
        $issues += "MCP config not found"
    }

    if ($issues.Count -gt 0) {
        Write-Status "Installation issues found:" "ERROR"
        $issues | ForEach-Object { Write-Status "  - $_" "ERROR" }
        return $false
    }

    Write-Status "✓ All verification checks passed!" "SUCCESS"
    return $true
}

# ============================================================
# Main Installation Flow
# ============================================================

try {
    Write-Host ""
    Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║   Token Optimizer MCP - Hooks Installer                  ║" -ForegroundColor Cyan
    Write-Host "║   Automated installation of global Claude Code hooks     ║" -ForegroundColor Cyan
    Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""

    if ($DryRun) {
        Write-Status "DRY RUN MODE - No changes will be made" "WARN"
        Write-Host ""
    }

    # Step 1: Prerequisites
    Test-Prerequisites
    Write-Host ""

    # Step 2: Install hooks files
    Install-HooksFiles
    Write-Host ""

    # Step 3: Configure Claude Code settings
    Configure-ClaudeSettings
    Write-Host ""

    # Step 4: Configure workspace trust
    Configure-WorkspaceTrust
    Write-Host ""

    # Step 5: Configure MCP server
    Configure-MCPServer
    Write-Host ""

    # Step 6: Verify installation
    if ($DryRun) {
        Write-Status "DRY RUN COMPLETE - No changes were made" "SUCCESS"
    } else {
        $verified = Test-Installation

        if ($verified) {
            Write-Host ""
            Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Green
            Write-Host "║   Installation Complete!                                  ║" -ForegroundColor Green
            Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Green
            Write-Host ""
            Write-Status "Next steps:" "INFO"
            Write-Status "1. Restart Claude Code CLI" "INFO"
            Write-Status "2. Run any command (e.g., claude 'help')" "INFO"
            Write-Status "3. Check logs: Get-Content '$HOOKS_DIR\logs\dispatcher.log' -Tail 20" "INFO"
            Write-Host ""
            Write-Status "Documentation: $env:USERPROFILE\source\repos\token-optimizer-mcp\HOOKS-INSTALLATION.md" "INFO"
        } else {
            throw "Installation verification failed"
        }
    }

} catch {
    Write-Host ""
    Write-Status "Installation failed: $($_.Exception.Message)" "ERROR"
    Write-Status "Check the error above and try again" "ERROR"
    Write-Status "For help, see: https://github.com/ooples/token-optimizer-mcp/issues" "INFO"
    exit 1
}
