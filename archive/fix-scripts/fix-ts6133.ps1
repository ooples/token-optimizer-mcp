# Script to fix all TS6133 unused variable warnings by prefixing with underscore

$ErrorActionPreference = 'Stop'
Set-Location "C:\Users\yolan\source\repos\token-optimizer-mcp"

# Get all TS6133 warnings
$warnings = npm run build 2>&1 | Select-String "TS6133"

Write-Host "Found $($warnings.Count) TS6133 warnings to fix"

# Parse warnings and group by file
$fileWarnings = @{}
foreach ($warning in $warnings) {
    # Parse: src/file.ts(line,col): error TS6133: 'varName' is declared but its value is never read.
    if ($warning -match "^(.+?)\((\d+),(\d+)\):.*'([^']+)'") {
        $file = $Matches[1]
        $line = [int]$Matches[2]
        $col = [int]$Matches[3]
        $varName = $Matches[4]

        if (-not $fileWarnings.ContainsKey($file)) {
            $fileWarnings[$file] = @()
        }

        $fileWarnings[$file] += @{
            Line = $line
            Col = $col
            VarName = $varName
        }
    }
}

Write-Host "Processing $($fileWarnings.Count) files..."

# Process each file
$totalFixed = 0
foreach ($file in $fileWarnings.Keys) {
    $fullPath = Join-Path $PWD $file

    if (-not (Test-Path $fullPath)) {
        Write-Host "Skipping $file - not found"
        continue
    }

    Write-Host "Processing $file with $($fileWarnings[$file].Count) warnings..."

    # Read file content
    $lines = Get-Content $fullPath -Encoding UTF8

    # Sort warnings by line number descending to avoid line number shifts
    $sortedWarnings = $fileWarnings[$file] | Sort-Object -Property Line -Descending

    # Apply fixes
    $modified = $false
    foreach ($warning in $sortedWarnings) {
        $lineIndex = $warning.Line - 1
        $varName = $warning.VarName

        if ($lineIndex -lt 0 -or $lineIndex -ge $lines.Count) {
            Write-Host "  Skipping invalid line $($warning.Line)"
            continue
        }

        $line = $lines[$lineIndex]

        # Skip if already prefixed with underscore
        if ($varName -match '^_') {
            Write-Host "  Skipping $varName - already has underscore"
            continue
        }

        # Replace variable name with underscore-prefixed version
        # Match patterns: const varName, let varName, var varName, { varName }, function(varName)
        $patterns = @(
            "const\s+$varName\b",
            "let\s+$varName\b",
            "var\s+$varName\b",
            "\{\s*$varName\s*[,\}]",
            "function\s*\(\s*$varName\b",
            "\(\s*$varName\s*[:,\)]",
            ",\s*$varName\s*[:,\)]"
        )

        $replaced = $false
        foreach ($pattern in $patterns) {
            if ($line -match $pattern) {
                $newLine = $line -replace "\b$varName\b", "_$varName"
                if ($newLine -ne $line) {
                    $lines[$lineIndex] = $newLine
                    $modified = $true
                    $replaced = $true
                    $totalFixed++
                    Write-Host "  Fixed: $varName -> _$varName on line $($warning.Line)"
                    break
                }
            }
        }

        if (-not $replaced) {
            Write-Host "  Warning: Could not fix $varName on line $($warning.Line)"
        }
    }

    # Write back if modified
    if ($modified) {
        $lines | Set-Content $fullPath -Encoding UTF8
        Write-Host "  Saved $file"
    }
}

Write-Host ""
Write-Host "Total fixed: $totalFixed warnings"
Write-Host ""
Write-Host "Running build to verify..."
npm run build 2>&1 | Select-String "TS6133" | Measure-Object | Select-Object -ExpandProperty Count
