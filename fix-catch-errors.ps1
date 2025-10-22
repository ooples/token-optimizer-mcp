# Mass fix ESLint unused error parameters in catch blocks ONLY
$files = Get-ChildItem -Path "C:\Users\yolan\source\repos\token-optimizer-mcp\src" -Recurse -Filter "*.ts"

$totalFixed = 0

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw
    $originalContent = $content

    # Only replace in catch blocks - more conservative patterns
    $content = $content -replace '\} catch \(error\) \{', '} catch (_error) {'
    $content = $content -replace 'catch \(error\) \{', 'catch (_error) {'

    if ($content -ne $originalContent) {
        Set-Content -Path $file.FullName -Value $content -NoNewline
        $totalFixed++
    }
}

Write-Host "Fixed unused error parameters in $totalFixed files"
