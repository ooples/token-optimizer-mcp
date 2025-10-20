# Get PR data and current HEAD
$prData = gh api repos/ooples/token-optimizer-mcp/pulls/28 | ConvertFrom-Json
$currentHead = $prData.head.sha
Write-Output "Current HEAD: $currentHead"
Write-Output ""

# Get ALL comments
$allComments = gh api repos/ooples/token-optimizer-mcp/pulls/28/comments --paginate | ConvertFrom-Json
Write-Output "Total comments on PR #28: $($allComments.Count)"
Write-Output ""

# Filter to Copilot comments on current HEAD
$copilotOnHead = @($allComments | Where-Object { $_.user.login -eq 'Copilot' -and $_.commit_id -eq $currentHead })
Write-Output "Copilot comments on current HEAD: $($copilotOnHead.Count)"
Write-Output ""

# Check if there's a 'resolved' field or other status field
Write-Output "Checking comment fields to understand resolution status..."
Write-Output ""

# Show first few comments with ALL their fields
Write-Output "Sample comment fields (first comment):"
$copilotOnHead[0] | ConvertTo-Json -Depth 3 | Out-String | Write-Output
Write-Output ""

# Check for fields that might indicate resolution
Write-Output "Checking for resolution-related fields in all comments on HEAD:"
$copilotOnHead | ForEach-Object {
    Write-Output "Comment ID: $($_.id)"
    Write-Output "  path: $($_.path):$($_.line)"
    Write-Output "  in_reply_to_id: $($_.in_reply_to_id)"
    Write-Output "  original_line: $($_.original_line)"
    Write-Output "  line: $($_.line)"
    Write-Output "  original_position: $($_.original_position)"
    Write-Output "  position: $($_.position)"
    Write-Output "  diff_hunk: $($_.diff_hunk -ne $null)"
    Write-Output ""
}
