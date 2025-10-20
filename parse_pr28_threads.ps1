# Parse the GraphQL result to find truly unresolved comments

$data = Get-Content pr28_threads.json | ConvertFrom-Json

# Get current HEAD
$prData = gh api repos/ooples/token-optimizer-mcp/pulls/28 | ConvertFrom-Json
$currentHead = $prData.head.sha

Write-Output "Current HEAD: $currentHead"
Write-Output ""

$threads = $data.data.repository.pullRequest.reviewThreads.nodes

# Filter threads
$allUnresolved = @($threads | Where-Object { $_.isResolved -eq $false })
$unresolvedOnHead = @($allUnresolved | Where-Object {
    $_.comments.nodes[0].commit.oid -eq $currentHead
})

Write-Output "===================================="
Write-Output "RESOLUTION STATUS SUMMARY"
Write-Output "===================================="
Write-Output "Total threads: $($threads.Count)"
Write-Output "All unresolved threads: $($allUnresolved.Count)"
Write-Output "Unresolved threads on current HEAD: $($unresolvedOnHead.Count)"
Write-Output ""

Write-Output "===================================="
Write-Output "KEY FINDING"
Write-Output "===================================="
Write-Output "TRUE unresolved count (isResolved=false + on HEAD): $($unresolvedOnHead.Count)"
Write-Output ""

# List them
if ($unresolvedOnHead.Count -gt 0) {
    Write-Output "Unresolved comments on current HEAD:"
    $unresolvedOnHead | ForEach-Object {
        $comment = $_.comments.nodes[0]
        $bodyPreview = $comment.body.Substring(0, [Math]::Min(100, $comment.body.Length))
        Write-Output "  - $($comment.path):$($comment.line)"
        Write-Output "    $bodyPreview..."
        Write-Output ""
    }
} else {
    Write-Output "✅ NO UNRESOLVED COMMENTS ON CURRENT HEAD!"
}
