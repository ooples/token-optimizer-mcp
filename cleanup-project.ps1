#!/usr/bin/env pwsh
# Cleanup script to organize 120+ loose files in the main directory

$ErrorActionPreference = "Stop"

Write-Host "🧹 Project Cleanup Script" -ForegroundColor Cyan
Write-Host "=" * 80

# Create archive directory for historical files
$archiveDir = "./archive"
$scriptsArchive = "$archiveDir/fix-scripts"
$docsArchive = "$archiveDir/docs"
$errorsArchive = "$archiveDir/error-logs"
$prArchive = "$archiveDir/pr-analysis"
$testsArchive = "$archiveDir/test-scripts"

Write-Host "`nCreating archive directories..."
New-Item -ItemType Directory -Force -Path $archiveDir, $scriptsArchive, $docsArchive, $errorsArchive, $prArchive, $testsArchive | Out-Null

# Function to move files safely
function Move-ToArchive {
    param($Pattern, $Destination)
    $files = Get-ChildItem -Path . -File -Filter $Pattern -ErrorAction SilentlyContinue
    if ($files) {
        $files | ForEach-Object {
            Write-Host "  Moving: $($_.Name) → $Destination" -ForegroundColor Gray
            Move-Item $_.FullName $Destination -Force
        }
    }
}

# 1. Move fix scripts
Write-Host "`n📦 Archiving fix scripts..."
Move-ToArchive "fix-*.cjs" $scriptsArchive
Move-ToArchive "fix-*.js" $scriptsArchive
Move-ToArchive "fix-*.mjs" $scriptsArchive
Move-ToArchive "fix-*.ps1" $scriptsArchive
Move-ToArchive "fix-*.sh" $scriptsArchive

# 2. Move error logs
Write-Host "`n📦 Archiving error logs..."
Move-ToArchive "*-errors.txt" $errorsArchive
Move-ToArchive "build-*.txt" $errorsArchive
Move-ToArchive "typescript-errors*.txt" $errorsArchive
Move-ToArchive "error-breakdown.txt" $errorsArchive

# 3. Move PR analysis files
Write-Host "`n📦 Archiving PR analysis..."
Move-ToArchive "pr*_threads.json" $prArchive
Move-ToArchive "pr*_*.json" $prArchive
Move-ToArchive "check_*.ps1" $prArchive
Move-ToArchive "debug_*.ps1" $prArchive
Move-ToArchive "investigate_*.ps1" $prArchive
Move-ToArchive "parse_*.ps1" $prArchive
Move-ToArchive "test_graphql*.ps1" $prArchive
Move-ToArchive "get_unresolved_graphql.ps1" $prArchive
Move-ToArchive "commits.txt" $prArchive
Move-ToArchive "copilot_comments.json" $prArchive

# 4. Move gemini/planning files
Write-Host "`n📦 Archiving planning documents..."
Move-ToArchive "gemini-*.md" $docsArchive
Move-ToArchive "gemini-*.txt" $docsArchive
Move-ToArchive "agent-*.md" $docsArchive
Move-ToArchive "AGENT-*.md" $docsArchive
Move-ToArchive "batch-*-instructions.md" $docsArchive
Move-ToArchive "*-fix-summary.md" $docsArchive
Move-ToArchive "*-FIX*.md" $docsArchive
Move-ToArchive "progress-manifest.json" $docsArchive
Move-ToArchive "fix-strategy.json" $docsArchive

# 5. Move test scripts
Write-Host "`n📦 Archiving test scripts..."
Move-ToArchive "test-*.js" $testsArchive
Move-ToArchive "test-*.ps1" $testsArchive
Move-ToArchive "test_*.ps1" $testsArchive
Move-ToArchive "verify-*.js" $testsArchive
Move-ToArchive "count-tokens.js" $testsArchive
Move-ToArchive "revert-*.cjs" $testsArchive
Move-ToArchive "remove-*.cjs" $testsArchive
Move-ToArchive "remove-*.ps1" $testsArchive
Move-ToArchive "create_*.ps1" $testsArchive
Move-ToArchive "test-orchestrator.ps1" $testsArchive
Move-ToArchive "wrapper.ps1" $testsArchive
Move-ToArchive "prepare-*.ps1" $testsArchive

# 6. Move archived/outdated docs
Write-Host "`n📦 Archiving old documentation..."
Move-ToArchive "PRIORITY_*" $docsArchive
Move-ToArchive "SESSION_LOG_SPEC.md" $docsArchive
Move-ToArchive "WRAPPER_DOCUMENTATION.md" $docsArchive
Move-ToArchive "CACHE_SET_FIX_PATTERN.md" $docsArchive
Move-ToArchive "ESLINT_WARNINGS.md" $docsArchive

# 7. Delete temporary files
Write-Host "`n🗑️  Deleting temporary files..."
$tempFiles = @(
    "audit-results.json",
    ".test-cache",
    "smart-metrics-formatted.ts",
    "unused-imports.txt",
    "mcp.json",
    "server.json",
    ".mcpregistry_registry_token"
)

foreach ($file in $tempFiles) {
    if (Test-Path $file) {
        Write-Host "  Deleting: $file" -ForegroundColor Yellow
        Remove-Item $file -Recurse -Force
    }
}

# 8. Create .gitignore in archive to keep it out of git tracking
Write-Host "`n📝 Creating archive/.gitignore..."
$gitignorePath = Join-Path $archiveDir ".gitignore"
$gitignoreContent = @"
# Archive directory - historical/temporary files only
*
"@
Set-Content -Path $gitignorePath -Value $gitignoreContent

# 9. Summary
Write-Host "`n" + ("=" * 80)
Write-Host "✅ Cleanup Complete!" -ForegroundColor Green
Write-Host "`nArchived files organized in ./archive/"
Write-Host "  - Fix scripts:      $scriptsArchive"
Write-Host "  - Error logs:       $errorsArchive"
Write-Host "  - PR analysis:      $prArchive"
Write-Host "  - Old docs:         $docsArchive"
Write-Host "  - Test scripts:     $testsArchive"
Write-Host "`n📁 Project root should now be clean!"
Write-Host "`nTo commit cleanup:"
Write-Host "  git add ."
Write-Host "  git commit -m 'chore: cleanup project directory - move 120+ temporary files to archive'"
