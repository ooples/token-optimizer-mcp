$prs = @(27, 28, 30)

foreach ($pr in $prs) {
    Write-Output "=========================================="
    Write-Output "PR #$pr"
    Write-Output "=========================================="

    # Get HEAD SHA
    $prData = gh api repos/ooples/token-optimizer-mcp/pulls/$pr | ConvertFrom-Json
    $HEAD = $prData.head.sha
    $title = $prData.title

    Write-Output "Title: $title"
    Write-Output "HEAD: $HEAD"

    # Get unresolved comments on HEAD
    $comments = gh api repos/ooples/token-optimizer-mcp/pulls/$pr/comments --paginate | ConvertFrom-Json
    $unresolved = $comments | Where-Object { $_.user.login -eq 'copilot' -and $_.commit_id -eq $HEAD }

    Write-Output "Unresolved comments on HEAD: $($unresolved.Count)"

    if ($unresolved.Count -gt 0) {
        Write-Output ""
        Write-Output "Sample comments:"
        $unresolved | Select-Object -First 3 | ForEach-Object {
            $preview = $_.body.Substring(0, [Math]::Min(80, $_.body.Length))
            Write-Output "  - $($_.path):$($_.line) - $preview..."
        }
    }

    Write-Output ""
}
