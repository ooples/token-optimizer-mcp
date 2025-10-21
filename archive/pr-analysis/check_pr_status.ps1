# Check status of all remaining open PRs
$openPRs = @(32, 33, 35, 37, 39, 40, 42, 43, 45, 46)

$results = @()

foreach ($prNumber in $openPRs) {
    try {
        $prData = gh pr view $prNumber --json title,mergeable,files,additions,deletions | ConvertFrom-Json

        $result = [PSCustomObject]@{
            PR = $prNumber
            Title = $prData.title.Substring(0, [Math]::Min(60, $prData.title.Length))
            Mergeable = $prData.mergeable
            FilesChanged = $prData.files.Count
            Additions = $prData.additions
            Deletions = $prData.deletions
        }

        $results += $result
    } catch {
        Write-Host "Error checking PR #$prNumber : $_" -ForegroundColor Red
    }
}

# Display results
$results | Format-Table -AutoSize

# Summary
Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
$emptyPRs = $results | Where-Object { $_.Additions -eq 0 -and $_.Deletions -eq 0 }
$conflictPRs = $results | Where-Object { $_.Mergeable -eq "CONFLICTING" }
$goodPRs = $results | Where-Object { $_.Mergeable -eq "MERGEABLE" -and ($_.Additions -gt 0 -or $_.Deletions -gt 0) }

Write-Host "Empty PRs (no changes): $($emptyPRs.Count)" -ForegroundColor Yellow
if ($emptyPRs.Count -gt 0) {
    $emptyPRs | ForEach-Object { Write-Host "  - PR #$($_.PR): $($_.Title)" }
}

Write-Host "`nPRs with merge conflicts: $($conflictPRs.Count)" -ForegroundColor Red
if ($conflictPRs.Count -gt 0) {
    $conflictPRs | ForEach-Object { Write-Host "  - PR #$($_.PR): $($_.Title)" }
}

Write-Host "`nGood PRs (mergeable with changes): $($goodPRs.Count)" -ForegroundColor Green
if ($goodPRs.Count -gt 0) {
    $goodPRs | ForEach-Object { Write-Host "  - PR #$($_.PR): $($_.Title) (+$($_.Additions)/-$($_.Deletions))" }
}
