# Simple cleanup script
Write-Host "Cleaning up project directory..."

# Create archive directory
New-Item -ItemType Directory -Force -Path "./archive/fix-scripts", "./archive/error-logs", "./archive/pr-analysis", "./archive/test-scripts", "./archive/docs" | Out-Null

# Move files
Get-ChildItem -Path . -File -Filter "fix-*.cjs" | Move-Item -Destination "./archive/fix-scripts" -Force
Get-ChildItem -Path . -File -Filter "fix-*.js" | Move-Item -Destination "./archive/fix-scripts" -Force
Get-ChildItem -Path . -File -Filter "fix-*.mjs" | Move-Item -Destination "./archive/fix-scripts" -Force
Get-ChildItem -Path . -File -Filter "fix-*.ps1" | Move-Item -Destination "./archive/fix-scripts" -Force
Get-ChildItem -Path . -File -Filter "fix-*.sh" | Move-Item -Destination "./archive/fix-scripts" -Force

Get-ChildItem -Path . -File -Filter "*-errors.txt" | Move-Item -Destination "./archive/error-logs" -Force
Get-ChildItem -Path . -File -Filter "build-*.txt" | Move-Item -Destination "./archive/error-logs" -Force
Get-ChildItem -Path . -File -Filter "typescript-errors*.txt" | Move-Item -Destination "./archive/error-logs" -Force

Get-ChildItem -Path . -File -Filter "pr*_*.json" | Move-Item -Destination "./archive/pr-analysis" -Force
Get-ChildItem -Path . -File -Filter "check_*.ps1" | Move-Item -Destination "./archive/pr-analysis" -Force
Get-ChildItem -Path . -File -Filter "*graphql*.ps1" | Move-Item -Destination "./archive/pr-analysis" -Force

Get-ChildItem -Path . -File -Filter "test-*.js" | Move-Item -Destination "./archive/test-scripts" -Force
Get-ChildItem -Path . -File -Filter "test-*.ps1" | Move-Item -Destination "./archive/test-scripts" -Force
Get-ChildItem -Path . -File -Filter "verify-*.js" | Move-Item -Destination "./archive/test-scripts" -Force
Get-ChildItem -Path . -File -Filter "wrapper.ps1" | Move-Item -Destination "./archive/test-scripts" -Force

Get-ChildItem -Path . -File -Filter "gemini-*" | Move-Item -Destination "./archive/docs" -Force
Get-ChildItem -Path . -File -Filter "agent-*" | Move-Item -Destination "./archive/docs" -Force
Get-ChildItem -Path . -File -Filter "AGENT-*" | Move-Item -Destination "./archive/docs" -Force
Get-ChildItem -Path . -File -Filter "batch-*" | Move-Item -Destination "./archive/docs" -Force

# Delete temp files
Remove-Item -Path "audit-results.json" -Force -ErrorAction SilentlyContinue
Remove-Item -Path ".test-cache" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "commits.txt" -Force -ErrorAction SilentlyContinue

Write-Host "Cleanup complete!"
