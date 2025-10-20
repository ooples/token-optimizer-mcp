$prs = gh pr list --json number,title,mergeable --limit 10 | ConvertFrom-Json

Write-Output "Checking merge status of open PRs..."
Write-Output ""

$prs | ForEach-Object {
    $status = switch ($_.mergeable) {
        "MERGEABLE" { "No conflicts" }
        "CONFLICTING" { "HAS MERGE CONFLICTS" }
        "UNKNOWN" { "Unknown (checking...)" }
        default { "Unknown status: $_" }
    }

    Write-Output "PR #$($_.number): $($_.title)"
    Write-Output "  Status: $status"
    Write-Output ""
}
