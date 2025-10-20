#!/bin/bash

# CI/CD Setup Verification Script
# This script verifies that all CI/CD components are properly configured

set -e

echo "============================================"
echo "CI/CD Setup Verification"
echo "============================================"
echo ""

ERRORS=0
WARNINGS=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_pass() {
    echo -e "${GREEN}✓${NC} $1"
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
    ERRORS=$((ERRORS + 1))
}

check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
    WARNINGS=$((WARNINGS + 1))
}

echo "1. Checking Workflow Files..."
echo "----------------------------"

if [ -f ".github/workflows/ci.yml" ]; then
    check_pass "CI workflow exists"
else
    check_fail "CI workflow missing"
fi

if [ -f ".github/workflows/release.yml" ]; then
    check_pass "Release workflow exists"
else
    check_fail "Release workflow missing"
fi

if [ -f ".github/workflows/quality-gates.yml" ]; then
    check_pass "Quality gates workflow exists"
else
    check_fail "Quality gates workflow missing"
fi

if [ -f ".github/workflows/commitlint.yml" ]; then
    check_pass "Commitlint workflow exists"
else
    check_fail "Commitlint workflow missing"
fi

echo ""
echo "2. Checking Configuration Files..."
echo "----------------------------"

if [ -f ".releaserc.json" ]; then
    check_pass "Semantic-release config exists"
    # Validate JSON
    if jq empty .releaserc.json 2>/dev/null; then
        check_pass "Semantic-release config is valid JSON"
    else
        check_fail "Semantic-release config is invalid JSON"
    fi
else
    check_fail "Semantic-release config missing"
fi

if [ -f ".commitlintrc.json" ]; then
    check_pass "Commitlint config exists"
    # Validate JSON
    if jq empty .commitlintrc.json 2>/dev/null; then
        check_pass "Commitlint config is valid JSON"
    else
        check_fail "Commitlint config is invalid JSON"
    fi
else
    check_fail "Commitlint config missing"
fi

if [ -f ".github/dependabot.yml" ]; then
    check_pass "Dependabot config exists"
else
    check_fail "Dependabot config missing"
fi

echo ""
echo "3. Checking Documentation..."
echo "----------------------------"

if [ -f ".github/README.md" ]; then
    check_pass "GitHub Actions README exists"
else
    check_fail "GitHub Actions README missing"
fi

if [ -f ".github/BRANCH_PROTECTION.md" ]; then
    check_pass "Branch protection guide exists"
else
    check_fail "Branch protection guide missing"
fi

if [ -f ".github/setup-ci.md" ]; then
    check_pass "Setup guide exists"
else
    check_fail "Setup guide missing"
fi

if [ -f ".github/RELEASE_FLOW.md" ]; then
    check_pass "Release flow diagram exists"
else
    check_fail "Release flow diagram missing"
fi

if [ -f ".github/SECRETS_TEMPLATE.md" ]; then
    check_pass "Secrets template exists"
else
    check_fail "Secrets template missing"
fi

echo ""
echo "4. Checking Baseline Files..."
echo "----------------------------"

if [ -f ".github/performance-baseline.json" ]; then
    check_pass "Performance baseline exists"
else
    check_warn "Performance baseline missing (will be created after first run)"
fi

if [ -f ".github/bundle-size-baseline.txt" ]; then
    check_pass "Bundle size baseline exists"
else
    check_warn "Bundle size baseline missing (needs to be created manually)"
fi

echo ""
echo "5. Checking package.json..."
echo "----------------------------"

if [ -f "package.json" ]; then
    check_pass "package.json exists"

    # Check for required scripts
    if grep -q '"test:ci"' package.json; then
        check_pass "test:ci script exists"
    else
        check_fail "test:ci script missing"
    fi

    if grep -q '"test:benchmark"' package.json; then
        check_pass "test:benchmark script exists"
    else
        check_fail "test:benchmark script missing"
    fi

    if grep -q '"test:integration"' package.json; then
        check_pass "test:integration script exists"
    else
        check_fail "test:integration script missing"
    fi

    # Check for semantic-release dependency
    if grep -q '"semantic-release"' package.json; then
        check_pass "semantic-release dependency exists"
    else
        check_fail "semantic-release dependency missing"
    fi

    # Check for commitlint dependencies
    if grep -q '"@commitlint/cli"' package.json; then
        check_pass "commitlint dependencies exist"
    else
        check_fail "commitlint dependencies missing"
    fi
else
    check_fail "package.json missing"
fi

echo ""
echo "6. Checking Node.js and npm..."
echo "----------------------------"

if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    check_pass "Node.js installed: $NODE_VERSION"

    # Check if version is 18 or higher
    MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$MAJOR_VERSION" -ge 18 ]; then
        check_pass "Node.js version is 18 or higher"
    else
        check_warn "Node.js version is below 18 (recommended: 18+)"
    fi
else
    check_fail "Node.js not installed"
fi

if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    check_pass "npm installed: v$NPM_VERSION"
else
    check_fail "npm not installed"
fi

echo ""
echo "7. Checking Git Configuration..."
echo "----------------------------"

if git rev-parse --git-dir > /dev/null 2>&1; then
    check_pass "Git repository initialized"

    REMOTE_URL=$(git config --get remote.origin.url)
    if [[ $REMOTE_URL == *"ooples/token-optimizer-mcp"* ]]; then
        check_pass "Remote URL correct: $REMOTE_URL"
    else
        check_warn "Remote URL may be incorrect: $REMOTE_URL"
    fi

    CURRENT_BRANCH=$(git branch --show-current)
    check_pass "Current branch: $CURRENT_BRANCH"
else
    check_fail "Not a git repository"
fi

echo ""
echo "8. Checking Dependencies..."
echo "----------------------------"

if [ -d "node_modules" ]; then
    check_pass "node_modules directory exists"

    # Check for specific packages
    if [ -d "node_modules/semantic-release" ]; then
        check_pass "semantic-release installed"
    else
        check_warn "semantic-release not installed (run 'npm install')"
    fi

    if [ -d "node_modules/@commitlint/cli" ]; then
        check_pass "@commitlint/cli installed"
    else
        check_warn "@commitlint/cli not installed (run 'npm install')"
    fi
else
    check_warn "node_modules not found (run 'npm install')"
fi

echo ""
echo "9. Checking Build Output..."
echo "----------------------------"

if [ -d "dist" ]; then
    check_pass "dist directory exists"

    if [ -f "dist/index.js" ] || [ -f "dist/server/index.js" ]; then
        check_pass "Build artifacts exist"
    else
        check_warn "Build artifacts missing (run 'npm run build')"
    fi
else
    check_warn "dist directory not found (run 'npm run build')"
fi

echo ""
echo "10. Testing Commands..."
echo "----------------------------"

# Test build command
if npm run build --dry-run &> /dev/null; then
    check_pass "Build command works"
else
    check_warn "Build command may have issues"
fi

# Test lint command
if npm run lint --dry-run &> /dev/null; then
    check_pass "Lint command works"
else
    check_warn "Lint command may have issues"
fi

# Test format check command
if npm run format:check --dry-run &> /dev/null; then
    check_pass "Format check command works"
else
    check_warn "Format check command may have issues"
fi

echo ""
echo "============================================"
echo "Verification Summary"
echo "============================================"
echo ""

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    echo ""
    echo "Your CI/CD pipeline is properly configured."
    echo "Next steps:"
    echo "  1. Configure GitHub secrets (NPM_TOKEN)"
    echo "  2. Set up branch protection rules"
    echo "  3. Create a test PR to verify workflows"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠ $WARNINGS warnings found${NC}"
    echo ""
    echo "Your CI/CD pipeline is mostly configured, but there are some warnings."
    echo "Review the warnings above and address them if needed."
    exit 0
else
    echo -e "${RED}✗ $ERRORS errors found${NC}"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}⚠ $WARNINGS warnings found${NC}"
    fi
    echo ""
    echo "Your CI/CD pipeline has configuration issues."
    echo "Please review the errors above and fix them."
    exit 1
fi
