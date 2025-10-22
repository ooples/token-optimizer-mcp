# Mass fix ESLint unused error parameters
$files = Get-ChildItem -Path "C:\Users\yolan\source\repos\token-optimizer-mcp\src" -Recurse -Filter "*.ts"

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw
    $content = $content -replace '} catch \(error\)', '} catch (_error)'
    $content = $content -replace '\(error\) \{', '(_error) {'
    $content = $content -replace '\(error\) =>', '(_error) =>'
    Set-Content -Path $file.FullName -Value $content -NoNewline
}

Write-Host "Fixed unused error parameters in all TypeScript files"
