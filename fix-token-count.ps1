# PowerShell script to fix TokenCountResult errors
$files = @(
    "src/tools/api-database/smart-orm.ts",
    "src/tools/api-database/smart-sql.ts",
    "src/tools/code-analysis/smart-ast-grep.ts",
    "src/tools/code-analysis/smart-dependencies.ts",
    "src/tools/code-analysis/smart-exports.ts",
    "src/tools/code-analysis/smart-imports.ts",
    "src/tools/code-analysis/smart-refactor.ts",
    "src/tools/configuration/smart-config-read.ts",
    "src/tools/configuration/smart-tsconfig.ts",
    "src/tools/file-operations/smart-branch.ts",
    "src/tools/file-operations/smart-edit.ts",
    "src/tools/file-operations/smart-glob.ts",
    "src/tools/file-operations/smart-grep.ts",
    "src/tools/file-operations/smart-write.ts",
    "src/tools/intelligence/sentiment-analysis.ts",
    "src/tools/configuration/smart-package-json.ts"
)

foreach ($file in $files) {
    if (Test-Path $file) {
        $content = Get-Content $file -Raw
        # Pattern 1: const x = tokenCounter.count(...);
        $content = $content -replace '(const\s+\w+\s*=\s*(?:this\.)?tokenCounter\.count\([^)]+\));', '$1.tokens;'
        # Pattern 2: tokenCounter.count(...) used in arithmetic or assignment where number is expected
        $content = $content -replace '(?<![.])tokenCounter\.count\(([^)]+)\)(?!\s*\.tokens)(?=\s*[+\-*/]|\s*;|\s*\))', 'tokenCounter.count($1).tokens'
        Set-Content $file $content -NoNewline
        Write-Host "Fixed $file"
    }
}
