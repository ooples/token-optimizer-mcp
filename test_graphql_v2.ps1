# Test GitHub GraphQL API for PR review comment resolution status
# Using JSON file approach for proper escaping

$queryJson = @{
    query = @"
query {
  repository(owner: \"ooples\", name: \"token-optimizer-mcp\") {
    pullRequest(number: 28) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          isCollapsed
          resolvedBy {
            login
          }
          comments(first: 10) {
            nodes {
              id
              body
              path
              line
              commit {
                oid
              }
              author {
                login
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
"@
} | ConvertTo-Json

# Save to temp file
$queryFile = "graphql_query.json"
$queryJson | Out-File -FilePath $queryFile -Encoding utf8

Write-Output "Executing GraphQL query to get PR #28 review threads with resolution status..."
Write-Output ""

# Execute GraphQL query using file input
$result = gh api graphql --input $queryFile | ConvertFrom-Json

# Clean up temp file
Remove-Item $queryFile

# Check if we got data
if ($result.data -and $result.data.repository -and $result.data.repository.pullRequest) {
    $threads = $result.data.repository.pullRequest.reviewThreads.nodes
    Write-Output "Total review threads found: $($threads.Count)"
    Write-Output ""

    # Count resolved vs unresolved
    $resolved = @($threads | Where-Object { $_.isResolved -eq $true })
    $unresolved = @($threads | Where-Object { $_.isResolved -eq $false })

    Write-Output "==================================="
    Write-Output "RESOLUTION STATUS SUMMARY"
    Write-Output "==================================="
    Write-Output "Resolved threads: $($resolved.Count)"
    Write-Output "Unresolved threads: $($unresolved.Count)"
    Write-Output "Outdated threads: $(($threads | Where-Object { $_.isOutdated -eq $true }).Count)"
    Write-Output ""

    # Get current HEAD for comparison
    $prData = gh api repos/ooples/token-optimizer-mcp/pulls/28 | ConvertFrom-Json
    $currentHead = $prData.head.sha
    Write-Output "Current PR HEAD: $currentHead"
    Write-Output ""

    # Show unresolved threads
    Write-Output "==================================="
    Write-Output "UNRESOLVED THREADS"
    Write-Output "==================================="
    $unresolvedOnHead = @()
    $unresolved | ForEach-Object {
        $thread = $_
        $firstComment = $thread.comments.nodes[0]
        if ($firstComment) {
            $onCurrentHead = $firstComment.commit.oid -eq $currentHead
            if ($onCurrentHead) {
                $unresolvedOnHead += $thread
            }
            Write-Output "Thread ID: $($thread.id)"
            Write-Output "  Path: $($firstComment.path):$($firstComment.line)"
            Write-Output "  Commit: $($firstComment.commit.oid)"
            Write-Output "  On current HEAD: $onCurrentHead"
            Write-Output "  Author: $($firstComment.author.login)"
            Write-Output "  isResolved: $($thread.isResolved)"
            Write-Output "  isOutdated: $($thread.isOutdated)"
            $bodyPreview = $firstComment.body.Substring(0, [Math]::Min(80, $firstComment.body.Length))
            Write-Output "  Body: $bodyPreview..."
            Write-Output ""
        }
    }

    Write-Output "==================================="
    Write-Output "KEY FINDING"
    Write-Output "==================================="
    Write-Output "Unresolved threads on current HEAD: $($unresolvedOnHead.Count)"
    Write-Output "This is the TRUE count of unresolved comments!"
    Write-Output ""

    # Show resolved threads for comparison
    Write-Output "==================================="
    Write-Output "RESOLVED THREADS (sample - first 5)"
    Write-Output "==================================="
    $resolved | Select-Object -First 5 | ForEach-Object {
        $thread = $_
        $firstComment = $thread.comments.nodes[0]
        if ($firstComment) {
            Write-Output "Thread ID: $($thread.id)"
            Write-Output "  Path: $($firstComment.path):$($firstComment.line)"
            Write-Output "  Commit: $($firstComment.commit.oid)"
            Write-Output "  On current HEAD: $($firstComment.commit.oid -eq $currentHead)"
            Write-Output "  isResolved: $($thread.isResolved)"
            Write-Output "  resolvedBy: $($thread.resolvedBy.login)"
            Write-Output ""
        }
    }

} else {
    Write-Output "ERROR: No data returned from GraphQL query"
    if ($result.errors) {
        Write-Output "Errors:"
        $result.errors | ForEach-Object {
            Write-Output "  - $($_.message)"
        }
    }
    Write-Output ""
    Write-Output "Full response:"
    $result | ConvertTo-Json -Depth 5
}
