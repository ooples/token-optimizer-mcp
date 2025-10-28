#!/bin/bash

###############################################################################
# Installation Test Script
#
# Tests the npm package installation locally before publishing to npm.
# This script packs the package, installs it in a temporary directory,
# and verifies it works correctly.
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEMP_DIR="/tmp/test-token-optimizer-mcp-$$"

echo -e "${BLUE}=== Token Optimizer MCP - Installation Test ===${NC}\n"

# Step 1: Clean and build
echo -e "${BLUE}Step 1: Building package...${NC}"
cd "$PROJECT_ROOT"
npm run clean || true
npm run build

if [ ! -d "dist" ]; then
    echo -e "${RED}✗ Build failed: dist/ directory not found${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Build successful${NC}\n"

# Step 2: Pack the package
echo -e "${BLUE}Step 2: Packing package...${NC}"
PACKAGE_FILE=$(npm pack 2>&1 | tail -n 1)

if [ ! -f "$PACKAGE_FILE" ]; then
    echo -e "${RED}✗ Pack failed: $PACKAGE_FILE not found${NC}"
    exit 1
fi

PACKAGE_SIZE=$(du -h "$PACKAGE_FILE" | cut -f1)
echo -e "${GREEN}✓ Package created: $PACKAGE_FILE (size: $PACKAGE_SIZE)${NC}\n"

# Step 3: Create temporary test directory
echo -e "${BLUE}Step 3: Setting up test environment...${NC}"
mkdir -p "$TEMP_DIR"
cd "$TEMP_DIR"
npm init -y > /dev/null 2>&1
echo -e "${GREEN}✓ Test environment ready${NC}\n"

# Step 4: Install the packed package
echo -e "${BLUE}Step 4: Installing package from tarball...${NC}"
npm install "$PROJECT_ROOT/$PACKAGE_FILE" --loglevel=error

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ Installation failed${NC}"
    rm -rf "$TEMP_DIR"
    rm -f "$PROJECT_ROOT/$PACKAGE_FILE"
    exit 1
fi
echo -e "${GREEN}✓ Installation successful${NC}\n"

# Step 5: Verify package structure
echo -e "${BLUE}Step 5: Verifying package structure...${NC}"

# Check if the package is installed
if [ ! -d "node_modules/token-optimizer-mcp" ]; then
    echo -e "${RED}✗ Package directory not found${NC}"
    rm -rf "$TEMP_DIR"
    rm -f "$PROJECT_ROOT/$PACKAGE_FILE"
    exit 1
fi

# Check for main entry point
if [ ! -f "node_modules/token-optimizer-mcp/dist/server/index.js" ]; then
    echo -e "${RED}✗ Main entry point not found${NC}"
    rm -rf "$TEMP_DIR"
    rm -f "$PROJECT_ROOT/$PACKAGE_FILE"
    exit 1
fi

# Check for TypeScript declarations
if [ ! -f "node_modules/token-optimizer-mcp/dist/server/index.d.ts" ]; then
    echo -e "${YELLOW}⚠ TypeScript declarations not found${NC}"
fi

# Check for required files
for file in README.md LICENSE CHANGELOG.md; do
    if [ ! -f "node_modules/token-optimizer-mcp/$file" ]; then
        echo -e "${YELLOW}⚠ $file not found in package${NC}"
    fi
done

echo -e "${GREEN}✓ Package structure verified${NC}\n"

# Step 6: Test CLI entry point
echo -e "${BLUE}Step 6: Testing CLI entry point...${NC}"

if [ -f "node_modules/.bin/token-optimizer-mcp" ]; then
    echo -e "${GREEN}✓ CLI entry point exists: token-optimizer-mcp${NC}"

    # Try to run the CLI (it will fail without proper MCP transport, but should at least load)
    # We just check if the file is executable and has a shebang
    if head -n 1 "node_modules/token-optimizer-mcp/dist/server/index.js" | grep -q "#!/usr/bin/env node"; then
        echo -e "${GREEN}✓ CLI has correct shebang${NC}"
    else
        echo -e "${RED}✗ CLI missing shebang${NC}"
    fi
else
    echo -e "${YELLOW}⚠ CLI entry point not found in node_modules/.bin/${NC}"
fi

echo ""

# Step 7: Verify dependencies are installed
echo -e "${BLUE}Step 7: Verifying dependencies...${NC}"

REQUIRED_DEPS=(
    "@modelcontextprotocol/sdk"
    "better-sqlite3"
    "tiktoken"
    "lru-cache"
)

MISSING_DEPS=0
for dep in "${REQUIRED_DEPS[@]}"; do
    if [ -d "node_modules/$dep" ]; then
        echo -e "${GREEN}✓ $dep installed${NC}"
    else
        echo -e "${RED}✗ $dep missing${NC}"
        MISSING_DEPS=$((MISSING_DEPS + 1))
    fi
done

echo ""

# Step 8: Check package size
echo -e "${BLUE}Step 8: Analyzing package contents...${NC}"
echo -e "Contents of node_modules/token-optimizer-mcp:"
ls -lh "node_modules/token-optimizer-mcp/" | head -20

INSTALLED_SIZE=$(du -sh "node_modules/token-optimizer-mcp" | cut -f1)
echo -e "\n${GREEN}✓ Installed package size: $INSTALLED_SIZE${NC}\n"

# Cleanup
echo -e "${BLUE}Cleaning up...${NC}"
cd "$PROJECT_ROOT"
rm -rf "$TEMP_DIR"
rm -f "$PACKAGE_FILE"
echo -e "${GREEN}✓ Cleanup complete${NC}\n"

# Summary
echo -e "${BLUE}=== Test Summary ===${NC}"
if [ $MISSING_DEPS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo -e "${GREEN}✓ Package is ready for publishing to npm${NC}"
    exit 0
else
    echo -e "${RED}✗ $MISSING_DEPS dependency/dependencies missing${NC}"
    echo -e "${YELLOW}⚠ Fix issues before publishing${NC}"
    exit 1
fi
