# Create worktrees for batch 1
$baseDir = "C:\Users\cheat\source\repos\token-optimizer-mcp"
$worktreesDir = "$baseDir\worktrees"

# Batch 1 stories
$stories = @(
    "us-bf-001-fix-incorrect-mcp-server-token-attribution-in-get",
    "us-bf-001-remove-unused-variables",
    "us-bf-002-fix-path-traversal-vulnerability-in-optimize-sessi",
    "us-bf-002-fix-type-mismatches",
    "us-bf-003-fix-token-count-result"
)

Write-Host "Creating worktrees for Batch 1..."
Write-Host ""

foreach ($story in $stories) {
    $branchName = "feat/$story"
    $worktreePath = "$worktreesDir\$story"

    Write-Host "Creating worktree: $story"

    # Create branch and worktree
    git worktree add -b $branchName $worktreePath master 2>&1 | Out-Null

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ Created: $worktreePath"
    } else {
        Write-Host "  ✗ Failed to create worktree" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Batch 1 worktrees created successfully!"
Write-Host "Total worktrees:" (git worktree list | Measure-Object -Line).Lines
