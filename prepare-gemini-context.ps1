# Script to prepare comprehensive context for Google Gemini analysis
# This will gather all error data and context needed for a rock-solid fix plan

$outputFile = "gemini-comprehensive-context.txt"
$projectPath = "C:\Users\yolan\source\repos\token-optimizer-mcp"

Set-Location $projectPath

# Start building the context file
@"
# COMPREHENSIVE TYPESCRIPT ERROR ANALYSIS FOR GOOGLE GEMINI
# Project: token-optimizer-mcp
# Current State: 729 TypeScript compilation errors
# Goal: Create a rock-solid comprehensive fix plan with expert AI agent assignments

## 1. FULL BUILD OUTPUT WITH ALL ERRORS
## =====================================

"@ | Out-File -FilePath $outputFile -Encoding UTF8

# Capture full build output
Write-Host "Capturing full build output..."
npm run build 2>&1 | Out-File -FilePath $outputFile -Append -Encoding UTF8

# Error breakdown by type
@"

## 2. ERROR BREAKDOWN BY TYPE
## ===========================

"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

npm run build 2>&1 | Select-String "error TS" | ForEach-Object {
    $_ -replace ".*error ", ""
} | ForEach-Object {
    ($_ -split ":")[0]
} | Group-Object | Sort-Object Count -Descending | ForEach-Object {
    "$($_.Count) $($_.Name)"
} | Out-File -FilePath $outputFile -Append -Encoding UTF8

# Error breakdown by file
@"

## 3. ERROR BREAKDOWN BY FILE (Top 30)
## ====================================

"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

npm run build 2>&1 | Select-String "error TS" | ForEach-Object {
    ($_ -split "\(")[0]
} | Group-Object | Sort-Object Count -Descending | Select-Object -First 30 | ForEach-Object {
    "$($_.Count) errors in $($_.Name)"
} | Out-File -FilePath $outputFile -Append -Encoding UTF8

# Key interface definitions
@"

## 4. KEY INTERFACE DEFINITIONS
## =============================

### TokenCountResult Interface
"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

Get-Content "src/core/token-counter.ts" | Select-String -Context 0,5 "interface TokenCountResult" | Out-File -FilePath $outputFile -Append -Encoding UTF8

@"

### CacheEngine Class
"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

Get-Content "src/core/cache-engine.ts" | Select-Object -First 100 | Out-File -FilePath $outputFile -Append -Encoding UTF8

# Sample error files
@"

## 5. SAMPLE FILES SHOWING ERROR PATTERNS
## =======================================

### TS2345 Sample (smart-user.ts)
"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

Get-Content "src/tools/system-operations/smart-user.ts" | Select-Object -First 50 | Out-File -FilePath $outputFile -Append -Encoding UTF8

@"

### TS2322 Sample (cache files)
"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

$cacheFiles = Get-ChildItem "src/tools/advanced-caching/*.ts" | Select-Object -First 1
Get-Content $cacheFiles[0].FullName | Select-Object -First 50 | Out-File -FilePath $outputFile -Append -Encoding UTF8

# Project structure
@"

## 6. PROJECT STRUCTURE
## =====================

"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

tree /F src | Select-Object -First 100 | Out-File -FilePath $outputFile -Append -Encoding UTF8

@"

## 7. PREVIOUS FIX ATTEMPTS AND RESULTS
## =====================================

- Started with: 897 errors
- After bad fix: 1039 errors
- After revert: 896 errors
- After variable definitions: 895 errors
- After crypto fixes: 890 errors
- After Agent A (Buffer→String): ~850 errors
- After Agent B (Function signatures): ~750 errors
- After Agent C (Type annotations): 729 errors (CURRENT)

Agents A, B, C made good progress but we need a comprehensive approach for the remaining 729 errors.

## 8. REQUEST TO GOOGLE GEMINI
## ============================

Please analyze all the errors above and create a comprehensive, rock-solid fix plan that:

1. **Groups errors by root cause** (not just by error code)
2. **Identifies dependencies** between errors (which must be fixed first)
3. **Creates optimal fix order** to minimize cascading effects
4. **Provides specific fix strategies** for each error group with exact code patterns
5. **Assigns errors to expert AI agents** with clear, actionable instructions
6. **Estimates impact** (how many errors each fix will resolve)
7. **Includes verification steps** to ensure fixes don't break other code

The plan should enable one final coordinated effort by expert AI agents to fix ALL remaining errors efficiently.

Please provide:
- Root cause analysis for each major error category
- Specific fix patterns with before/after code examples
- Agent assignments with file lists and exact instructions
- Expected error reduction per agent
- Overall execution strategy (parallel vs sequential, dependencies)

"@ | Out-File -FilePath $outputFile -Append -Encoding UTF8

Write-Host "`nContext file created: $outputFile"
Write-Host "File size: $((Get-Item $outputFile).Length / 1KB) KB"
Write-Host "`nNext: Use 'gemini chat' with this file to get comprehensive fix plan"
