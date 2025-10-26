#!/usr/bin/env bash
# Token Optimizer MCP - Automated Hooks Installer (macOS/Linux)
# Installs global Claude Code hooks for automatic token optimization

set -euo pipefail

# ============================================================
# Configuration
# ============================================================

FORCE=false
SKIP_MCP_CHECK=false
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE=true
            shift
            ;;
        --skip-mcp-check)
            SKIP_MCP_CHECK=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --force           Force reinstall even if already installed"
            echo "  --skip-mcp-check  Skip MCP server installation check"
            echo "  --dry-run         Preview changes without applying"
            echo "  -h, --help        Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Run '$0 --help' for usage information"
            exit 1
            ;;
    esac
done

HOOKS_DIR="$HOME/.claude-global/hooks"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_STATE="$HOME/.claude.json"

# Determine Claude Desktop config path based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    MCP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "/usr/local")
    MCP_GLOBAL_PATH="$NPM_PREFIX/lib/node_modules/@ooples/token-optimizer-mcp"
else
    MCP_CONFIG="$HOME/.config/Claude/claude_desktop_config.json"
    NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "/usr/local")
    MCP_GLOBAL_PATH="$NPM_PREFIX/lib/node_modules/@ooples/token-optimizer-mcp"
fi

REPO_URL="https://raw.githubusercontent.com/ooples/token-optimizer-mcp/main/hooks"

# ============================================================
# Helper Functions
# ============================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

write_status() {
    local message="$1"
    local type="${2:-INFO}"

    case "$type" in
        SUCCESS)
            echo -e "${GREEN}[SUCCESS]${NC} $message"
            ;;
        ERROR)
            echo -e "${RED}[ERROR]${NC} $message"
            ;;
        WARN)
            echo -e "${YELLOW}[WARN]${NC} $message"
            ;;
        *)
            echo -e "${CYAN}[INFO]${NC} $message"
            ;;
    esac
}

test_prerequisites() {
    write_status "Checking prerequisites..." "INFO"

    # Check Bash version
    if [[ ${BASH_VERSION%%.*} -lt 4 ]]; then
        echo "Bash 4.0 or later is required. Current version: $BASH_VERSION"
        exit 1
    fi
    write_status "✓ Bash version: $BASH_VERSION" "SUCCESS"

    # Check Claude Code is installed
    if ! command -v claude &> /dev/null; then
        echo "Claude Code CLI not found. Install from: https://docs.claude.com/en/docs/claude-code"
        exit 1
    fi
    local claude_version=$(claude --version 2>&1 || echo "unknown")
    write_status "✓ Claude Code installed: $claude_version" "SUCCESS"

    # Check npm is installed
    if ! command -v npm &> /dev/null; then
        echo "npm not found. Install Node.js from: https://nodejs.org/"
        exit 1
    fi
    local npm_version=$(npm --version)
    write_status "✓ npm version: $npm_version" "SUCCESS"

    # Check token-optimizer-mcp is installed (optional)
    if [[ "$SKIP_MCP_CHECK" == "false" ]]; then
        if [[ ! -d "$MCP_GLOBAL_PATH" ]]; then
            write_status "token-optimizer-mcp not found" "WARN"
            write_status "Install with: npm install -g @ooples/token-optimizer-mcp" "INFO"

            read -p "Install token-optimizer-mcp now? (y/n) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                npm install -g @ooples/token-optimizer-mcp
                write_status "✓ token-optimizer-mcp installed" "SUCCESS"
            else
                echo "token-optimizer-mcp is required for hooks to work"
                exit 1
            fi
        else
            write_status "✓ token-optimizer-mcp found" "SUCCESS"
        fi
    fi
}

install_hooks_files() {
    write_status "Installing hooks files..." "INFO"

    # Create hooks directory
    if [[ ! -d "$HOOKS_DIR" ]]; then
        mkdir -p "$HOOKS_DIR"
        write_status "✓ Created hooks directory: $HOOKS_DIR" "SUCCESS"
    fi

    # Create subdirectories
    for dir in handlers helpers logs data; do
        mkdir -p "$HOOKS_DIR/$dir"
    done

    if [[ "$DRY_RUN" == "true" ]]; then
        write_status "[DRY RUN] Would download hooks files from $REPO_URL" "INFO"
        return
    fi

    # Download hooks files
    declare -A files=(
        ["dispatcher.sh"]="$HOOKS_DIR/dispatcher.sh"
        ["handlers/token-optimizer-orchestrator.sh"]="$HOOKS_DIR/handlers/token-optimizer-orchestrator.sh"
        ["helpers/invoke-mcp.sh"]="$HOOKS_DIR/helpers/invoke-mcp.sh"
    )

    for source in "${!files[@]}"; do
        local dest="${files[$source]}"
        local url="$REPO_URL/$source"

        write_status "Downloading: $url" "INFO"

        if curl -fsSL "$url" -o "$dest" 2>/dev/null; then
            chmod +x "$dest"
            write_status "✓ Downloaded: $(basename "$dest")" "SUCCESS"
        else
            write_status "⚠ Failed to download $url" "ERROR"
            write_status "Using local package files instead..." "INFO"

            # Fallback: Copy from npm package
            local npm_hooks="$MCP_GLOBAL_PATH/hooks"
            if [[ -d "$npm_hooks" ]]; then
                cp -r "$npm_hooks"/* "$HOOKS_DIR/"
                chmod +x "$HOOKS_DIR"/*.sh
                write_status "✓ Copied hooks from npm package" "SUCCESS"
            else
                echo "Could not download hooks and npm package not found"
                exit 1
            fi
            break
        fi
    done
}

configure_claude_settings() {
    write_status "Configuring Claude Code settings..." "INFO"

    # Create .claude directory if it doesn't exist
    mkdir -p "$(dirname "$CLAUDE_SETTINGS")"

    # Backup existing settings
    if [[ -f "$CLAUDE_SETTINGS" ]]; then
        local backup="$CLAUDE_SETTINGS.backup.$(date +%Y%m%d-%H%M%S)"
        cp "$CLAUDE_SETTINGS" "$backup"
        write_status "✓ Backed up existing settings to: $backup" "SUCCESS"
    fi

    # Create or update settings.json
    local hook_command="bash $HOOKS_DIR/dispatcher.sh"

    local settings=$(cat <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$hook_command PreToolUse"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$hook_command PostToolUse"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$hook_command UserPromptSubmit"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$hook_command PreCompact"
          }
        ]
      }
    ]
  }
}
EOF
)

    if [[ "$DRY_RUN" == "true" ]]; then
        write_status "[DRY RUN] Would write hooks configuration to: $CLAUDE_SETTINGS" "INFO"
        echo "$settings"
        return
    fi

    # If settings file exists, merge with existing settings using jq if available
    if [[ -f "$CLAUDE_SETTINGS" ]] && command -v jq &> /dev/null; then
        local merged=$(jq -s '.[0] * .[1]' "$CLAUDE_SETTINGS" <(echo "$settings"))
        echo "$merged" > "$CLAUDE_SETTINGS"
    else
        echo "$settings" > "$CLAUDE_SETTINGS"
    fi

    write_status "✓ Updated Claude Code settings" "SUCCESS"
}

configure_workspace_trust() {
    write_status "Configuring workspace trust..." "INFO"

    local current_dir=$(pwd)

    if [[ ! -f "$CLAUDE_STATE" ]]; then
        write_status "No .claude.json found - trust will be prompted on first run" "WARN"
        return
    fi

    # Backup existing state
    local backup="$CLAUDE_STATE.backup.$(date +%Y%m%d-%H%M%S)"
    cp "$CLAUDE_STATE" "$backup"

    # Update state using jq if available, otherwise manual JSON manipulation
    if command -v jq &> /dev/null; then
        local updated=$(jq ".projects[\"$current_dir\"].hasTrustDialogAccepted = true" "$CLAUDE_STATE")
        echo "$updated" > "$CLAUDE_STATE"
    else
        write_status "jq not found - workspace trust must be accepted manually on first run" "WARN"
        return
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        write_status "[DRY RUN] Would accept workspace trust for: $current_dir" "INFO"
        return
    fi

    write_status "✓ Accepted workspace trust for: $current_dir" "SUCCESS"
}

configure_mcp_server() {
    write_status "Configuring MCP server..." "INFO"

    # Create MCP config directory
    mkdir -p "$(dirname "$MCP_CONFIG")"

    local mcp_path="$MCP_GLOBAL_PATH/dist/index.js"

    local mcp_settings=$(cat <<EOF
{
  "mcpServers": {
    "token-optimizer": {
      "type": "stdio",
      "command": "node",
      "args": [
        "$mcp_path"
      ],
      "env": {}
    }
  }
}
EOF
)

    if [[ "$DRY_RUN" == "true" ]]; then
        write_status "[DRY RUN] Would configure MCP server in: $MCP_CONFIG" "INFO"
        echo "$mcp_settings"
        return
    fi

    # Merge with existing config if it exists and jq is available
    if [[ -f "$MCP_CONFIG" ]] && command -v jq &> /dev/null; then
        local merged=$(jq -s '.[0] * .[1]' "$MCP_CONFIG" <(echo "$mcp_settings"))
        echo "$merged" > "$MCP_CONFIG"
    else
        echo "$mcp_settings" > "$MCP_CONFIG"
    fi

    write_status "✓ Configured token-optimizer MCP server" "SUCCESS"
}

test_installation() {
    write_status "Verifying installation..." "INFO"

    local issues=()

    # Check hooks files exist
    local required_files=(
        "$HOOKS_DIR/dispatcher.sh"
        "$HOOKS_DIR/handlers/token-optimizer-orchestrator.sh"
        "$HOOKS_DIR/helpers/invoke-mcp.sh"
    )

    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            issues+=("Missing file: $file")
        fi
    done

    # Check settings.json has hooks
    if [[ -f "$CLAUDE_SETTINGS" ]]; then
        if ! grep -q '"hooks"' "$CLAUDE_SETTINGS"; then
            issues+=("Hooks not configured in settings.json")
        fi
    else
        issues+=("Settings.json not found")
    fi

    # Check MCP server configured
    if [[ -f "$MCP_CONFIG" ]]; then
        if ! grep -q '"token-optimizer"' "$MCP_CONFIG"; then
            issues+=("token-optimizer MCP server not configured")
        fi
    else
        issues+=("MCP config not found")
    fi

    if [[ ${#issues[@]} -gt 0 ]]; then
        write_status "Installation issues found:" "ERROR"
        for issue in "${issues[@]}"; do
            write_status "  - $issue" "ERROR"
        done
        return 1
    fi

    write_status "✓ All verification checks passed!" "SUCCESS"
    return 0
}

# ============================================================
# Main Installation Flow
# ============================================================

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║   Token Optimizer MCP - Hooks Installer                  ║"
echo "║   Automated installation of global Claude Code hooks     ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
    write_status "DRY RUN MODE - No changes will be made" "WARN"
    echo ""
fi

# Step 1: Prerequisites
test_prerequisites
echo ""

# Step 2: Install hooks files
install_hooks_files
echo ""

# Step 3: Configure Claude Code settings
configure_claude_settings
echo ""

# Step 4: Configure workspace trust
configure_workspace_trust
echo ""

# Step 5: Configure MCP server
configure_mcp_server
echo ""

# Step 6: Verify installation
if [[ "$DRY_RUN" == "true" ]]; then
    write_status "DRY RUN COMPLETE - No changes were made" "SUCCESS"
else
    if test_installation; then
        echo ""
        echo "╔═══════════════════════════════════════════════════════════╗"
        echo "║   Installation Complete!                                  ║"
        echo "╚═══════════════════════════════════════════════════════════╝"
        echo ""
        write_status "Next steps:" "INFO"
        write_status "1. Restart Claude Code CLI" "INFO"
        write_status "2. Run any command (e.g., claude 'help')" "INFO"
        write_status "3. Check logs: tail -f '$HOOKS_DIR/logs/dispatcher.log'" "INFO"
        echo ""
        write_status "Documentation: $HOME/source/repos/token-optimizer-mcp/HOOKS-INSTALLATION.md" "INFO"
    else
        echo "Installation verification failed"
        exit 1
    fi
fi
