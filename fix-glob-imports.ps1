# Fix incorrect glob imports across all TypeScript files
$files = @(
    "src/tools/file-operations/smart-glob.ts",
    "src/tools/file-operations/smart-grep.ts",
    "src/tools/code-analysis/smart-dependencies.ts",
    "src/tools/configuration/smart-tsconfig.ts"
)

foreach ($file in $files) {
    $fullPath = Join-Path $PSScriptRoot $file
    if (Test-Path $fullPath) {
        $content = Get-Content $fullPath -Raw

        # Fix the import
        $oldPattern = "import glob from 'glob';`r?`nconst \{ globSync \} = glob;"
        $newPattern = "import { globSync } from 'glob';"

        if ($content -match [regex]::Escape("import glob from 'glob'")) {
            $content = $content -replace "import glob from 'glob';[\r\n]+const \{ globSync \} = glob;", "import { globSync } from 'glob';"
            Set-Content $fullPath $content -NoNewline -Encoding UTF8
            Write-Host "✅ Fixed: $file"
        }
    }
}

Write-Host "`n✅ All glob imports fixed!"
