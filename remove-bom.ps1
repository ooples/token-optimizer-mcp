$content = Get-Content -Path 'src/tools/api-database/smart-rest.ts' -Raw
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText('src/tools/api-database/smart-rest.ts', $content, $utf8NoBom)
Write-Host "BOM removed successfully"
