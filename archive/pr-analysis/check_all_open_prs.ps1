# Check all open PRs for unresolved Copilot comments
$openPRs = @(32, 33, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46)

foreach ($prNumber in $openPRs) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "PR #$prNumber" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    # Get PR details
    $prDetails = gh pr view $prNumber --json title,url | ConvertFrom-Json
    Write-Host "Title: $($prDetails.title)"
    Write-Host "URL: $($prDetails.url)"
    Write-Host ""

    # Get review threads using GraphQL
    $query = @"
query {
  repository(owner: "ooples", name: "token-optimizer-mcp") {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(first: 10) {
            nodes {
              author {
                login
              }
              body
            }
          }
        }
      }
    }
  }
}
"@

    try {
        $result = gh api graphql -f query=$query | ConvertFrom-Json
        $threads = $result.data.repository.pullRequest.reviewThreads.nodes

        $unresolved = ($threads | Where-Object { $_.isResolved -eq $false -and $_.isOutdated -eq $false }).Count
        $outdated = ($threads | Where-Object { $_.isOutdated -eq $true }).Count
        $resolved = ($threads | Where-Object { $_.isResolved -eq $true -and $_.isOutdated -eq $false }).Count

        Write-Host "Unresolved (not outdated): $unresolved" -ForegroundColor Yellow
        Write-Host "Outdated: $outdated" -ForegroundColor Gray
        Write-Host "Resolved: $resolved" -ForegroundColor Green
        Write-Host "Total threads: $($threads.Count)"

        if ($unresolved -gt 0) {
            Write-Host "`nUnresolved Comments:" -ForegroundColor Red
            $unresolvedThreads = $threads | Where-Object { $_.isResolved -eq $false -and $_.isOutdated -eq $false }
            foreach ($thread in $unresolvedThreads) {
                $firstComment = $thread.comments.nodes[0]
                Write-Host "  - $($firstComment.author.login): $($firstComment.body.Substring(0, [Math]::Min(100, $firstComment.body.Length)))..."
            }
        }

        Write-Host ""
    } catch {
        Write-Host "Error fetching data: $_" -ForegroundColor Red
    }
}
