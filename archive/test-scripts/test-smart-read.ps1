# Test smart_read MCP tool
$ErrorActionPreference = "Continue"

Write-Host "=== Testing smart_read MCP Tool ===" -ForegroundColor Cyan

# Test file path
$testFile = "C:\Users\cheat\source\repos\token-optimizer-mcp\package.json"

Write-Host "`n[Test 1] First read (cache miss expected)" -ForegroundColor Yellow

$mcpArgs = @{
    path = $testFile
    enableCache = $true
    diffMode = $true
    maxSize = 100000
    includeMetadata = $true
}
$argsJson = $mcpArgs | ConvertTo-Json -Compress

Write-Host "Calling smart_read for: $testFile"
$result1Json = & "C:\Users\cheat\.claude-global\hooks\helpers\invoke-mcp.ps1" -Tool "mcp__token-optimizer__smart_read" -ArgumentsJson $argsJson

if ($result1Json) {
    $result1 = $result1Json | ConvertFrom-Json
    Write-Host "Success: $($result1.content.Length) characters read" -ForegroundColor Green
    Write-Host "From cache: $($result1.metadata.fromCache)" -ForegroundColor $(if ($result1.metadata.fromCache) { "Green" } else { "Yellow" })
    Write-Host "Is diff: $($result1.metadata.isDiff)" -ForegroundColor Cyan
    Write-Host "Token count: $($result1.metadata.tokenCount)" -ForegroundColor Cyan
    Write-Host "Tokens saved: $($result1.metadata.tokensSaved)" -ForegroundColor Cyan
} else {
    Write-Host "FAILED: No result returned" -ForegroundColor Red
}

Write-Host "`n[Test 2] Second read (cache hit expected)" -ForegroundColor Yellow
Start-Sleep -Seconds 2

$result2Json = & "C:\Users\cheat\.claude-global\hooks\helpers\invoke-mcp.ps1" -Tool "mcp__token-optimizer__smart_read" -ArgumentsJson $argsJson

if ($result2Json) {
    $result2 = $result2Json | ConvertFrom-Json
    Write-Host "Success: $($result2.content.Length) characters read" -ForegroundColor Green
    Write-Host "From cache: $($result2.metadata.fromCache)" -ForegroundColor $(if ($result2.metadata.fromCache) { "Green" } else { "Red" })
    Write-Host "Is diff: $($result2.metadata.isDiff)" -ForegroundColor Cyan
    Write-Host "Token count: $($result2.metadata.tokenCount)" -ForegroundColor Cyan
    Write-Host "Tokens saved: $($result2.metadata.tokensSaved)" -ForegroundColor Cyan

    if ($result2.metadata.fromCache) {
        Write-Host "`n✅ CACHE HIT! Token savings achieved!" -ForegroundColor Green
    } else {
        Write-Host "`n❌ CACHE MISS - caching not working" -ForegroundColor Red
    }
} else {
    Write-Host "FAILED: No result returned" -ForegroundColor Red
}

Write-Host "`n=== Test Complete ===" -ForegroundColor Cyan
