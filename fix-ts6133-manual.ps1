# Manual fixes for remaining TS6133 warnings that require removal or complex patterns

$ErrorActionPreference = 'Stop'
Set-Location "C:\Users\yolan\source\repos\token-optimizer-mcp"

Write-Host "Fixing remaining 109 TS6133 warnings..."

# Pattern 1: Remove lines with _actualTokens (completely unused, already has underscore)
Write-Host "`n=== Pattern 1: Removing _actualTokens declarations ==="
$files = @(
    "src/tools/api-database/smart-sql.ts"
)

foreach ($file in $files) {
    if (Test-Path $file) {
        Write-Host "Processing $file..."
        $content = Get-Content $file -Raw
        $originalContent = $content

        # Remove lines containing "const _actualTokens ="
        $content = $content -replace "(?m)^\s*const _actualTokens = .+;\r?\n", ""

        if ($content -ne $originalContent) {
            Set-Content $file -Value $content -Encoding UTF8 -NoNewline
            Write-Host "  Fixed: Removed _actualTokens declarations"
        }
    }
}

# Pattern 2: Remove unused imports that are on a single line
Write-Host "`n=== Pattern 2: Fixing single-line unused imports ==="
$importFixes = @{
    "src/tools/advanced-caching/cache-analytics.ts" = @("mkdirSync")
    "src/tools/output-formatting/smart-format.ts" = @("statSync", "createWriteStream", "existsSync", "readFileSync", "writeFileSync")
    "src/tools/api-database/smart-rest.ts" = @("createHash")
}

foreach ($file in $importFixes.Keys) {
    if (Test-Path $file) {
        Write-Host "Processing $file..."
        $content = Get-Content $file -Raw
        $originalContent = $content

        foreach ($import in $importFixes[$file]) {
            # Try to remove from destructured import
            $content = $content -replace ",\s*$import\s*", ""
            $content = $content -replace "$import\s*,\s*", ""
            $content = $content -replace "\{\s*$import\s*\}", "{}"
        }

        if ($content -ne $originalContent) {
            Set-Content $file -Value $content -Encoding UTF8 -NoNewline
            Write-Host "  Fixed: Removed unused imports"
        }
    }
}

# Pattern 3: Remove unused variable declarations inside functions
Write-Host "`n=== Pattern 3: Removing unused local variables ==="
$localVarFixes = @(
    @{
        File = "src/tools/advanced-caching/cache-benchmark.ts"
        Line = 867
        Pattern = "const cache = "
    },
    @{
        File = "src/tools/advanced-caching/cache-compression.ts"
        Line = 231
        Pattern = "const deltaStates = "
    },
    @{
        File = "src/tools/advanced-caching/cache-compression.ts"
        Line = 232
        Pattern = "const compressionDictionaries = "
    },
    @{
        File = "src/tools/api-database/smart-database.ts"
        Line = 5
        Pattern = "const CacheEngineClass = "
    },
    @{
        File = "src/tools/api-database/smart-orm.ts"
        Line = 178
        Pattern = "const _relationships = "
    }
)

foreach ($fix in $localVarFixes) {
    $file = $fix.File
    if (Test-Path $file) {
        Write-Host "Processing $file at line $($fix.Line)..."
        $lines = Get-Content $file -Encoding UTF8
        $lineIndex = $fix.Line - 1

        if ($lineIndex -ge 0 -and $lineIndex -lt $lines.Count) {
            $line = $lines[$lineIndex]
            if ($line -match [regex]::Escape($fix.Pattern)) {
                # Remove the entire line
                $lines = $lines[0..($lineIndex-1)] + $lines[($lineIndex+1)..($lines.Count-1)]
                $lines | Set-Content $file -Encoding UTF8
                Write-Host "  Fixed: Removed line $($fix.Line)"
            }
        }
    }
}

# Pattern 4: Prefix variables in destructured imports/parameters
Write-Host "`n=== Pattern 4: Prefixing variables in complex patterns ==="
$complexFixes = @(
    @{
        File = "src/tools/build-systems/smart-build.ts"
        Lines = @(120, 121)
        Vars = @("tokenCounter", "metrics")
    },
    @{
        File = "src/tools/build-systems/smart-lint.ts"
        Lines = @(153, 154, 364)
        Vars = @("tokenCounter", "metrics", "_markAsIgnored")
    },
    @{
        File = "src/tools/build-systems/smart-typecheck.ts"
        Lines = @(113, 114)
        Vars = @("tokenCounter", "metrics")
    },
    @{
        File = "src/tools/system-operations/smart-cleanup.ts"
        Lines = @(5)  # "path" import - needs to be handled carefully
        Vars = @()    # Skip path for now as it's an import name conflict
    }
)

foreach ($fix in $complexFixes) {
    $file = $fix.File
    if ((Test-Path $file) -and $fix.Vars.Count -gt 0) {
        Write-Host "Processing $file..."
        $content = Get-Content $file -Raw
        $originalContent = $content

        foreach ($var in $fix.Vars) {
            if ($var -notmatch '^_') {
                # Prefix with underscore using word boundary
                $content = $content -replace "\b$var\b", "_$var"
            } else {
                # Variable already has underscore but still unused - remove the line
                $content = $content -replace "(?m)^\s*const $var = .+;\r?\n", ""
            }
        }

        if ($content -ne $originalContent) {
            Set-Content $file -Value $content -Encoding UTF8 -NoNewline
            Write-Host "  Fixed: Handled variables in $file"
        }
    }
}

Write-Host "`n=== Running build to verify ==="
npm run build 2>&1 | Select-String "TS6133" | Measure-Object | Select-Object -ExpandProperty Count
