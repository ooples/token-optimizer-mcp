# Test orchestrator smart-read action
$testInput = @"
{"tool_name":"Read","tool_input":{"file_path":"C:\\Users\\cheat\\source\\repos\\token-optimizer-mcp\\package.json"}}
"@

Write-Host "Testing orchestrator smart-read action..." -ForegroundColor Cyan
Write-Host "Input: $testInput" -ForegroundColor Yellow

# Pass via stdin properly (same way dispatcher does it)
$testInput | powershell -NoProfile -ExecutionPolicy Bypass -Command "
  & 'C:\Users\cheat\.claude-global\hooks\handlers\token-optimizer-orchestrator.ps1' -Phase 'PreToolUse' -Action 'smart-read'
"

Write-Host "`nExit code: $LASTEXITCODE" -ForegroundColor $(if ($LASTEXITCODE -eq 2) { "Green" } else { "Red" })

if (Test-Path "C:\Users\cheat\.claude-global\hooks\logs\token-optimizer-orchestrator.log") {
    Write-Host "`nOrchestrator log (last 20 lines):" -ForegroundColor Cyan
    Get-Content "C:\Users\cheat\.claude-global\hooks\logs\token-optimizer-orchestrator.log" -Tail 20
} else {
    Write-Host "`nOrchestrator log NOT FOUND" -ForegroundColor Red
}
