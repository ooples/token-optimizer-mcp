# Test script for token-optimizer PowerShell helper

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$result = & "$scriptDir\invoke-token-optimizer.ps1" `
    -Tool "count_tokens" `
    -Arguments @{text="Testing from PowerShell"}

if ($result) {
    Write-Host "SUCCESS! Result:"
    $result | ConvertTo-Json -Depth 10
} else {
    Write-Host "FAILED - No result returned"
    exit 1
}
