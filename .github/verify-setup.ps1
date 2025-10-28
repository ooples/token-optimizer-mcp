# CI/CD Setup Verification Script (PowerShell)
# This script verifies that all CI/CD components are properly configured

$ErrorActionPreference = "Continue"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "CI/CD Setup Verification" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$Errors = 0
$Warnings = 0

function Check-Pass {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Check-Fail {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
    $script:Errors++
}

function Check-Warn {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
    $script:Warnings++
}

Write-Host "1. Checking Workflow Files..."
Write-Host "----------------------------"

if (Test-Path ".github\workflows\ci.yml") {
    Check-Pass "CI workflow exists"
} else {
    Check-Fail "CI workflow missing"
}

if (Test-Path ".github\workflows\release.yml") {
    Check-Pass "Release workflow exists"
} else {
    Check-Fail "Release workflow missing"
}

if (Test-Path ".github\workflows\quality-gates.yml") {
    Check-Pass "Quality gates workflow exists"
} else {
    Check-Fail "Quality gates workflow missing"
}

if (Test-Path ".github\workflows\commitlint.yml") {
    Check-Pass "Commitlint workflow exists"
} else {
    Check-Fail "Commitlint workflow missing"
}

Write-Host ""
Write-Host "2. Checking Configuration Files..."
Write-Host "----------------------------"

if (Test-Path ".releaserc.json") {
    Check-Pass "Semantic-release config exists"
    # Validate JSON
    try {
        $null = Get-Content ".releaserc.json" | ConvertFrom-Json
        Check-Pass "Semantic-release config is valid JSON"
    } catch {
        Check-Fail "Semantic-release config is invalid JSON"
    }
} else {
    Check-Fail "Semantic-release config missing"
}

if (Test-Path ".commitlintrc.json") {
    Check-Pass "Commitlint config exists"
    # Validate JSON
    try {
        $null = Get-Content ".commitlintrc.json" | ConvertFrom-Json
        Check-Pass "Commitlint config is valid JSON"
    } catch {
        Check-Fail "Commitlint config is invalid JSON"
    }
} else {
    Check-Fail "Commitlint config missing"
}

if (Test-Path ".github\dependabot.yml") {
    Check-Pass "Dependabot config exists"
} else {
    Check-Fail "Dependabot config missing"
}

Write-Host ""
Write-Host "3. Checking Documentation..."
Write-Host "----------------------------"

if (Test-Path ".github\README.md") {
    Check-Pass "GitHub Actions README exists"
} else {
    Check-Fail "GitHub Actions README missing"
}

if (Test-Path ".github\BRANCH_PROTECTION.md") {
    Check-Pass "Branch protection guide exists"
} else {
    Check-Fail "Branch protection guide missing"
}

if (Test-Path ".github\setup-ci.md") {
    Check-Pass "Setup guide exists"
} else {
    Check-Fail "Setup guide missing"
}

if (Test-Path ".github\RELEASE_FLOW.md") {
    Check-Pass "Release flow diagram exists"
} else {
    Check-Fail "Release flow diagram missing"
}

if (Test-Path ".github\SECRETS_TEMPLATE.md") {
    Check-Pass "Secrets template exists"
} else {
    Check-Fail "Secrets template missing"
}

Write-Host ""
Write-Host "4. Checking Baseline Files..."
Write-Host "----------------------------"

if (Test-Path ".github\performance-baseline.json") {
    Check-Pass "Performance baseline exists"
} else {
    Check-Warn "Performance baseline missing (will be created after first run)"
}

if (Test-Path ".github\bundle-size-baseline.txt") {
    Check-Pass "Bundle size baseline exists"
} else {
    Check-Warn "Bundle size baseline missing (needs to be created manually)"
}

Write-Host ""
Write-Host "5. Checking package.json..."
Write-Host "----------------------------"

if (Test-Path "package.json") {
    Check-Pass "package.json exists"

    $packageJson = Get-Content "package.json" -Raw

    # Check for required scripts
    if ($packageJson -match '"test:ci"') {
        Check-Pass "test:ci script exists"
    } else {
        Check-Fail "test:ci script missing"
    }

    if ($packageJson -match '"test:benchmark"') {
        Check-Pass "test:benchmark script exists"
    } else {
        Check-Fail "test:benchmark script missing"
    }

    if ($packageJson -match '"test:integration"') {
        Check-Pass "test:integration script exists"
    } else {
        Check-Fail "test:integration script missing"
    }

    # Check for semantic-release dependency
    if ($packageJson -match '"semantic-release"') {
        Check-Pass "semantic-release dependency exists"
    } else {
        Check-Fail "semantic-release dependency missing"
    }

    # Check for commitlint dependencies
    if ($packageJson -match '"@commitlint/cli"') {
        Check-Pass "commitlint dependencies exist"
    } else {
        Check-Fail "commitlint dependencies missing"
    }
} else {
    Check-Fail "package.json missing"
}

Write-Host ""
Write-Host "6. Checking Node.js and npm..."
Write-Host "----------------------------"

$nodeVersion = $null
try {
    $nodeVersion = node --version
    Check-Pass "Node.js installed: $nodeVersion"

    # Check if version is 18 or higher
    $majorVersion = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($majorVersion -ge 18) {
        Check-Pass "Node.js version is 18 or higher"
    } else {
        Check-Warn "Node.js version is below 18 (recommended: 18+)"
    }
} catch {
    Check-Fail "Node.js not installed"
}

$npmVersion = $null
try {
    $npmVersion = npm --version
    Check-Pass "npm installed: v$npmVersion"
} catch {
    Check-Fail "npm not installed"
}

Write-Host ""
Write-Host "7. Checking Git Configuration..."
Write-Host "----------------------------"

try {
    $gitDir = git rev-parse --git-dir 2>&1
    if ($LASTEXITCODE -eq 0) {
        Check-Pass "Git repository initialized"

        $remoteUrl = git config --get remote.origin.url
        if ($remoteUrl -match "ooples/token-optimizer-mcp") {
            Check-Pass "Remote URL correct: $remoteUrl"
        } else {
            Check-Warn "Remote URL may be incorrect: $remoteUrl"
        }

        $currentBranch = git branch --show-current
        Check-Pass "Current branch: $currentBranch"
    } else {
        Check-Fail "Not a git repository"
    }
} catch {
    Check-Fail "Git not installed or not a repository"
}

Write-Host ""
Write-Host "8. Checking Dependencies..."
Write-Host "----------------------------"

if (Test-Path "node_modules") {
    Check-Pass "node_modules directory exists"

    # Check for specific packages
    if (Test-Path "node_modules\semantic-release") {
        Check-Pass "semantic-release installed"
    } else {
        Check-Warn "semantic-release not installed (run 'npm install')"
    }

    if (Test-Path "node_modules\@commitlint\cli") {
        Check-Pass "@commitlint/cli installed"
    } else {
        Check-Warn "@commitlint/cli not installed (run 'npm install')"
    }
} else {
    Check-Warn "node_modules not found (run 'npm install')"
}

Write-Host ""
Write-Host "9. Checking Build Output..."
Write-Host "----------------------------"

if (Test-Path "dist") {
    Check-Pass "dist directory exists"

    if ((Test-Path "dist\index.js") -or (Test-Path "dist\server\index.js")) {
        Check-Pass "Build artifacts exist"
    } else {
        Check-Warn "Build artifacts missing (run 'npm run build')"
    }
} else {
    Check-Warn "dist directory not found (run 'npm run build')"
}

Write-Host ""
Write-Host "10. Testing TypeScript Configuration..."
Write-Host "----------------------------"

if (Test-Path "tsconfig.json") {
    Check-Pass "tsconfig.json exists"
} else {
    Check-Fail "tsconfig.json missing"
}

if (Test-Path "jest.config.js") {
    Check-Pass "jest.config.js exists"
} else {
    Check-Fail "jest.config.js missing"
}

if (Test-Path "eslint.config.js") {
    Check-Pass "eslint.config.js exists"
} else {
    Check-Fail "eslint.config.js missing"
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Verification Summary" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

if ($Errors -eq 0 -and $Warnings -eq 0) {
    Write-Host "✓ All checks passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Your CI/CD pipeline is properly configured."
    Write-Host "Next steps:"
    Write-Host "  1. Configure GitHub secrets (NPM_TOKEN)"
    Write-Host "  2. Set up branch protection rules"
    Write-Host "  3. Create a test PR to verify workflows"
    exit 0
} elseif ($Errors -eq 0) {
    Write-Host "⚠ $Warnings warnings found" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Your CI/CD pipeline is mostly configured, but there are some warnings."
    Write-Host "Review the warnings above and address them if needed."
    exit 0
} else {
    Write-Host "✗ $Errors errors found" -ForegroundColor Red
    if ($Warnings -gt 0) {
        Write-Host "⚠ $Warnings warnings found" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Your CI/CD pipeline has configuration issues."
    Write-Host "Please review the errors above and fix them."
    exit 1
}
