# Test GitHub GraphQL API for PR review comment resolution status

# GraphQL query to get PR review threads with resolution status
$query = @'
query {
  repository(owner: "ooples", name: "token_optimizer_mcp") {
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
'@

Write-Output "Executing GraphQL query to get PR #28 review threads with resolution status..."
Write-Output ""

# Execute GraphQL query
$result = gh api graphql -f query=$query | ConvertFrom-Json

# Check if we got data
if ($result.data.repository.pullRequest.reviewThreads) {
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

    # Show unresolved threads
    Write-Output "==================================="
    Write-Output "UNRESOLVED THREADS"
    Write-Output "==================================="
    $unresolved | ForEach-Object {
        $thread = $_
        $firstComment = $thread.comments.nodes[0]
        if ($firstComment) {
            Write-Output "Thread ID: $($thread.id)"
            Write-Output "  Path: $($firstComment.path):$($firstComment.line)"
            Write-Output "  Commit: $($firstComment.commit.oid)"
            Write-Output "  Author: $($firstComment.author.login)"
            Write-Output "  isResolved: $($thread.isResolved)"
            Write-Output "  isOutdated: $($thread.isOutdated)"
            $bodyPreview = $firstComment.body.Substring(0, [Math]::Min(80, $firstComment.body.Length))
            Write-Output "  Body: $bodyPreview..."
            Write-Output ""
        }
    }

    # Show resolved threads for comparison
    Write-Output "==================================="
    Write-Output "RESOLVED THREADS (sample)"
    Write-Output "==================================="
    $resolved | Select-Object -First 5 | ForEach-Object {
        $thread = $_
        $firstComment = $thread.comments.nodes[0]
        if ($firstComment) {
            Write-Output "Thread ID: $($thread.id)"
            Write-Output "  Path: $($firstComment.path):$($firstComment.line)"
            Write-Output "  Commit: $($firstComment.commit.oid)"
            Write-Output "  isResolved: $($thread.isResolved)"
            Write-Output "  resolvedBy: $($thread.resolvedBy.login)"
            Write-Output ""
        }
    }

} else {
    Write-Output "ERROR: No data returned from GraphQL query"
    Write-Output "Response: $($result | ConvertTo-Json -Depth 5)"
}
