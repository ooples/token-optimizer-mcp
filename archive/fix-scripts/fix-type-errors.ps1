# PowerShell script to fix 166 type mismatch errors

$projectPath = "C:\Users\yolan\source\repos\token-optimizer-mcp"
$filesFixed = 0

Write-Host "Starting type error fixes..." -ForegroundColor Green

# Pattern 1: Fix metrics.recordOperation() calls - number to string conversion
# Looking for: metrics.recordOperation(name, duration, NUMBER)
# Replace with: metrics.recordOperation(name, duration, NUMBER.toString())

$metricsFiles = @(
    "src\tools\api-database\smart-api-fetch.ts",
    "src\tools\api-database\smart-cache-api.ts",
    "src\tools\api-database\smart-graphql.ts",
    "src\tools\api-database\smart-migration.ts",
    "src\tools\api-database\smart-orm.ts",
    "src\tools\api-database\smart-schema.ts",
    "src\tools\api-database\smart-sql.ts",
    "src\tools\api-database\smart-websocket.ts",
    "src\tools\build-systems\smart-build.ts",
    "src\tools\build-systems\smart-docker.ts",
    "src\tools\build-systems\smart-install.ts",
    "src\tools\build-systems\smart-lint.ts",
    "src\tools\build-systems\smart-logs.ts",
    "src\tools\build-systems\smart-network.ts",
    "src\tools\code-analysis\smart-complexity.ts",
    "src\tools\code-analysis\smart-exports.ts",
    "src\tools\code-analysis\smart-imports.ts",
    "src\tools\code-analysis\smart-refactor.ts",
    "src\tools\code-analysis\smart-security.ts",
    "src\tools\code-analysis\smart-symbols.ts",
    "src\tools\code-analysis\smart-typescript.ts",
    "src\tools\configuration\smart-config-read.ts",
    "src\tools\configuration\smart-package-json.ts",
    "src\tools\configuration\smart-tsconfig.ts",
    "src\tools\file-operations\smart-branch.ts",
    "src\tools\file-operations\smart-edit.ts",
    "src\tools\file-operations\smart-glob.ts",
    "src\tools\file-operations\smart-grep.ts",
    "src\tools\file-operations\smart-log.ts",
    "src\tools\file-operations\smart-merge.ts",
    "src\tools\file-operations\smart-read.ts",
    "src\tools\file-operations\smart-status.ts",
    "src\tools\file-operations\smart-write.ts",
    "src\tools\output-formatting\smart-pretty.ts",
    "src\tools\system-operations\smart-cron.ts",
    "src\tools\system-operations\smart-process.ts",
    "src\tools\system-operations\smart-service.ts",
    "src\tools\system-operations\smart-user.ts"
)

foreach ($file in $metricsFiles) {
    $fullPath = Join-Path $projectPath $file
    if (Test-Path $fullPath) {
        $content = Get-Content $fullPath -Raw
        $originalContent = $content

        # Fix metrics.recordOperation calls with number as third argument
        $content = $content -replace 'metrics\.recordOperation\(([^,]+),\s*([^,]+),\s*inputTokens\)', 'metrics.recordOperation($1, $2, inputTokens.toString())'
        $content = $content -replace 'metrics\.recordOperation\(([^,]+),\s*([^,]+),\s*totalTokens\)', 'metrics.recordOperation($1, $2, totalTokens.toString())'
        $content = $content -replace 'this\.metrics\.recordOperation\(([^,]+),\s*([^,]+),\s*inputTokens\)', 'this.metrics.recordOperation($1, $2, inputTokens.toString())'
        $content = $content -replace 'this\.metrics\.recordOperation\(([^,]+),\s*([^,]+),\s*totalTokens\)', 'this.metrics.recordOperation($1, $2, totalTokens.toString())'

        if ($content -ne $originalContent) {
            Set-Content $fullPath $content -NoNewline
            Write-Host "Fixed: $file" -ForegroundColor Yellow
            $filesFixed++
        }
    }
}

Write-Host "`nFixed $filesFixed files" -ForegroundColor Green
Write-Host "Run 'npm run build' to verify fixes" -ForegroundColor Cyan
