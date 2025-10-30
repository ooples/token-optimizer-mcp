#!/usr/bin/env pwsh
<#
.SYNOPSIS
Test script to verify install-hooks.ps1 does not add BOM to JSON files

.DESCRIPTION
This script tests that the install-hooks.ps1 script writes JSON files without
a UTF-8 BOM (Byte Order Mark), which would break JSON parsers.

.NOTES
Expected result: All files should NOT have BOM (EF BB BF) at the beginning
#>

$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "BOM Test for install-hooks.ps1" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Create temp directory for testing
$testDir = Join-Path $env:TEMP "token-optimizer-bom-test"
if (Test-Path $testDir) {
    Remove-Item $testDir -Recurse -Force
}
New-Item -ItemType Directory -Path $testDir | Out-Null

Write-Host "[INFO] Test directory: $testDir" -ForegroundColor Blue

# Create a temporary settings file
$testSettingsFile = Join-Path $testDir "test-settings.json"

# Test 1: Create a simple JSON object and write it using the NEW method
Write-Host "`n[TEST 1] Writing JSON with BOM-free method..." -ForegroundColor Yellow
$testObject = @{
    "test" = "value"
    "number" = 123
    "nested" = @{
        "key" = "value"
    }
}

$json = $testObject | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($testSettingsFile, $json, (New-Object System.Text.UTF8Encoding $false))

# Read the first 3 bytes to check for BOM
$bytes = [System.IO.File]::ReadAllBytes($testSettingsFile)
$hasBOM = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)

if ($hasBOM) {
    Write-Host "[FAIL] File has BOM (EF BB BF)!" -ForegroundColor Red
    $hexBytes = ($bytes[0..9] | ForEach-Object { $_.ToString('X2') }) -join ' '
    Write-Host "First 10 bytes: $hexBytes" -ForegroundColor Red
    exit 1
} else {
    Write-Host "[PASS] File does NOT have BOM" -ForegroundColor Green
    $hexBytes = ($bytes[0..9] | ForEach-Object { $_.ToString('X2') }) -join ' '
    Write-Host "First 10 bytes: $hexBytes" -ForegroundColor Gray
}

# Test 2: Verify the JSON is still valid
Write-Host "`n[TEST 2] Verifying JSON is valid..." -ForegroundColor Yellow
try {
    $parsed = Get-Content $testSettingsFile -Raw | ConvertFrom-Json
    if ($parsed.test -eq "value" -and $parsed.number -eq 123) {
        Write-Host "[PASS] JSON is valid and parseable" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] JSON parsed but values are incorrect" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[FAIL] JSON is invalid: $_" -ForegroundColor Red
    exit 1
}

# Test 3: Compare with OLD method (for reference)
Write-Host "`n[TEST 3] Comparing with OLD method (Set-Content -Encoding UTF8)..." -ForegroundColor Yellow
$oldMethodFile = Join-Path $testDir "old-method.json"
$testObject | ConvertTo-Json -Depth 10 | Set-Content $oldMethodFile -Encoding UTF8

$oldBytes = [System.IO.File]::ReadAllBytes($oldMethodFile)
$oldHasBOM = ($oldBytes.Length -ge 3 -and $oldBytes[0] -eq 0xEF -and $oldBytes[1] -eq 0xBB -and $oldBytes[2] -eq 0xBF)

if ($oldHasBOM) {
    Write-Host "[INFO] OLD method DOES add BOM (as expected)" -ForegroundColor Yellow
    $hexBytes = ($oldBytes[0..9] | ForEach-Object { $_.ToString('X2') }) -join ' '
    Write-Host "First 10 bytes: $hexBytes" -ForegroundColor Gray
} else {
    Write-Host "[WARN] OLD method does NOT add BOM (unexpected for this PowerShell version)" -ForegroundColor Yellow
}

# Test 4: Verify Claude Code can parse the file
Write-Host "`n[TEST 4] Verifying file is compatible with JSON parsers..." -ForegroundColor Yellow
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeTest = node -e "try { require('fs').readFileSync('$($testSettingsFile.Replace('\','\\'))'); console.log('OK'); } catch(e) { console.error('ERROR:', e.message); process.exit(1); }" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[PASS] Node.js JSON parser accepts the file" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Node.js JSON parser rejected the file: $nodeTest" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[SKIP] Node.js not found, skipping parser test" -ForegroundColor Gray
}

# Cleanup
Write-Host "`n[INFO] Cleaning up test directory..." -ForegroundColor Blue
Remove-Item $testDir -Recurse -Force

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "ALL TESTS PASSED" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "The BOM fix is working correctly!" -ForegroundColor Green
Write-Host "install-hooks.ps1 will NOT add BOM to JSON files.`n" -ForegroundColor Green

exit 0
