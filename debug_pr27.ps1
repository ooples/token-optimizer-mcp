$prData = gh api repos/ooples/token-optimizer-mcp/pulls/27 | ConvertFrom-Json
$HEAD = $prData.head.sha
Write-Output "HEAD: $HEAD"
Write-Output ""

$comments = gh api repos/ooples/token-optimizer-mcp/pulls/27/comments --paginate | ConvertFrom-Json
Write-Output "Total comments: $($comments.Count)"
Write-Output ""

Write-Output "All Copilot comments with user.login values:"
$copilotComments = $comments | Where-Object { $_.user.login -match 'copilot' -or $_.user.login -match 'Copilot' }
$copilotComments | ForEach-Object {
    Write-Output "  user.login: '$($_.user.login)' | commit_id: $($_.commit_id) | matches HEAD: $($_.commit_id -eq $HEAD)"
}
Write-Output ""

Write-Output "Testing different login filters:"
Write-Output "  lowercase 'copilot': $(($comments | Where-Object { $_.user.login -eq 'copilot' }).Count)"
Write-Output "  capitalized 'Copilot': $(($comments | Where-Object { $_.user.login -eq 'Copilot' }).Count)"
Write-Output "  'github-copilot[bot]': $(($comments | Where-Object { $_.user.login -eq 'github-copilot[bot]' }).Count)"
Write-Output ""

Write-Output "Comments on HEAD commit:"
$unresolved = $comments | Where-Object { $_.commit_id -eq $HEAD }
Write-Output "  Any user: $($unresolved.Count)"
$unresolved | ForEach-Object {
    Write-Output "    - user.login: '$($_.user.login)' | path: $($_.path):$($_.line)"
}
