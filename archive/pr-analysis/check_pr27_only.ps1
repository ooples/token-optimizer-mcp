$prData = gh api repos/ooples/token-optimizer-mcp/pulls/27 | ConvertFrom-Json
$HEAD = $prData.head.sha
Write-Output "HEAD: $HEAD"
Write-Output ""

$comments = gh api repos/ooples/token-optimizer-mcp/pulls/27/comments --paginate | ConvertFrom-Json
$onHead = $comments | Where-Object { $_.commit_id -eq $HEAD }
Write-Output "All comments on HEAD commit: $($onHead.Count)"
$onHead | ForEach-Object {
    $bodyPreview = $_.body.Substring(0, [Math]::Min(100, $_.body.Length))
    Write-Output "  user.login: '$($_.user.login)' | path: $($_.path):$($_.line)"
    Write-Output "  body: $bodyPreview..."
    Write-Output ""
}
