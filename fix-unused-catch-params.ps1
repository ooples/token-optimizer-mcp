# Fix unused catch block parameters by prefixing with underscore
$files = Get-ChildItem -Path "C:\Users\yolan\source\repos\token-optimizer-mcp\src" -Recurse -Filter "*.ts"

$totalFixed = 0

foreach ($file in $files) {
    $lines = Get-Content $file.FullName
    $modified = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        # Match catch blocks with various parameter names
        # Common patterns: catch (error), catch (e), catch (parseError), etc.
        if ($line -match 'catch\s+\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*\{') {
            $paramName = $matches[1]

            # Check if the parameter is NOT used in the catch block
            # Look ahead a few lines to see if the parameter is referenced
            $usedInBlock = $false
            $blockDepth = 1
            $j = $i + 1

            while ($j -lt $lines.Count -and $blockDepth -gt 0) {
                $checkLine = $lines[$j]

                # Count braces to track block depth
                $blockDepth += ($checkLine.ToCharArray() | Where-Object { $_ -eq '{' }).Count
                $blockDepth -= ($checkLine.ToCharArray() | Where-Object { $_ -eq '}' }).Count

                # Check if parameter is used (but not in comments)
                if ($checkLine -match "[^\w_]$paramName[^\w_]" -and $checkLine -notmatch "^\s*//") {
                    $usedInBlock = $true
                    break
                }

                $j++
                if ($j - $i -gt 50) { break } # Safety limit
            }

            # If not used, prefix with underscore
            if (-not $usedInBlock -and -not $paramName.StartsWith('_')) {
                $lines[$i] = $line -replace "catch\s+\($paramName\)", "catch (_$paramName)"
                $modified = $true
                Write-Host "Fixed $paramName in $($file.Name):$($i+1)"
            }
        }
    }

    if ($modified) {
        Set-Content -Path $file.FullName -Value ($lines -join "`n")
        $totalFixed++
    }
}

Write-Host "`nFixed $totalFixed files"
