# Get unresolved PR review threads using GraphQL API

Write-Output "Fetching PR #28 review threads with resolution status..."
Write-Output ""

# Execute GraphQL query (get all threads - may need pagination)
$result = gh api graphql -f query='
query {
  repository(owner: "ooples", name: "token-optimizer-mcp") {
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
          comments(first: 1) {
            nodes {
              path
              line
              body
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
' | ConvertFrom-Json

if ($result.data.repository.pullRequest.reviewThreads) {
    $threads = $result.data.repository.pullRequest.reviewThreads.nodes

    # Get current HEAD
    $prData = gh api repos/ooples/token-optimizer-mcp/pulls/28 | ConvertFrom-Json
    $currentHead = $prData.head.sha

    Write-Output "Current PR HEAD: $currentHead"
    Write-Output "Total review threads: $($threads.Count)"
    Write-Output ""

    # Filter threads
    $allUnresolved = @($threads | Where-Object { $_.isResolved -eq $false })
    $unresolvedOnHead = @($allUnresolved | Where-Object {
        $_.comments.nodes[0].commit.oid -eq $currentHead
    })
    $resolvedThreads = @($threads | Where-Object { $_.isResolved -eq $true })
    $resolvedOnHead = @($resolvedThreads | Where-Object {
        $_.comments.nodes[0].commit.oid -eq $currentHead
    })

    Write-Output "===================================="
    Write-Output "RESOLUTION STATUS SUMMARY"
    Write-Output "===================================="
    Write-Output "All unresolved threads: $($allUnresolved.Count)"
    Write-Output "Unresolved threads on current HEAD: $($unresolvedOnHead.Count)"
    Write-Output "Resolved threads: $($resolvedThreads.Count)"
    Write-Output "Resolved threads still on HEAD: $($resolvedOnHead.Count)"
    Write-Output ""

    Write-Output "===================================="
    Write-Output "KEY FINDING"
    Write-Output "===================================="
    Write-Output "TRUE unresolved count: $($unresolvedOnHead.Count)"
    Write-Output ""
    Write-Output "This is the count we should use!"
    Write-Output "REST API gave us: $(($threads | Where-Object { $_.comments.nodes[0].commit.oid -eq $currentHead -and $_.comments.nodes[0].author.login -match 'copilot' }).Count) comments on HEAD"
    Write-Output "But $($resolvedOnHead.Count) of those are already resolved!"
    Write-Output ""

    # Show unresolved threads on current HEAD
    if ($unresolvedOnHead.Count -gt 0) {
        Write-Output "===================================="
        Write-Output "UNRESOLVED THREADS ON CURRENT HEAD"
        Write-Output "===================================="
        $unresolvedOnHead | ForEach-Object {
            $thread = $_
            $comment = $thread.comments.nodes[0]
            $bodyPreview = $comment.body.Substring(0, [Math]::Min(100, $comment.body.Length))
            Write-Output "Path: $($comment.path):$($comment.line)"
            Write-Output "  Body: $bodyPreview..."
            Write-Output "  Commit: $($comment.commit.oid)"
            Write-Output ""
        }
    } else {
        Write-Output "✅ NO UNRESOLVED COMMENTS ON CURRENT HEAD!"
    }

    # Show resolved threads still on HEAD (for comparison)
    if ($resolvedOnHead.Count -gt 0) {
        Write-Output "===================================="
        Write-Output "RESOLVED THREADS STILL ON HEAD"
        Write-Output "===================================="
        Write-Output "(These are on current HEAD but marked resolved in UI)"
        Write-Output ""
        $resolvedOnHead | Select-Object -First 5 | ForEach-Object {
            $thread = $_
            $comment = $thread.comments.nodes[0]
            $bodyPreview = $comment.body.Substring(0, [Math]::Min(80, $comment.body.Length))
            Write-Output "Path: $($comment.path):$($comment.line)"
            Write-Output "  Body: $bodyPreview..."
            Write-Output "  Resolved by: $($thread.resolvedBy.login)"
            Write-Output ""
        }
    }

} else {
    Write-Output "ERROR: No data returned"
}
