# PowerShell script to fix API mismatches in System Operations tools
# Fixes: TokenCounter.count(), cache.get(), cache.set()

$files = @(
    "C:\Users\yolan\source\repos\token-optimizer-mcp\src\tools\system-operations\smart-user.ts",
    "C:\Users\yolan\source\repos\token-optimizer-mcp\src\tools\system-operations\smart-archive.ts",
    "C:\Users\yolan\source\repos\token-optimizer-mcp\src\tools\system-operations\smart-cleanup.ts",
    "C:\Users\yolan\source\repos\token-optimizer-mcp\src\tools\system-operations\smart-cron.ts",
    "C:\Users\yolan\source\repos\token-optimizer-mcp\src\tools\system-operations\smart-metrics.ts"
)

foreach ($file in $files) {
    Write-Host "Processing $file..."

    $content = Get-Content $file -Raw

    # Fix 1: cache.get() returns string, remove .toString('utf-8')
    $content = $content -replace "cached\.toString\('utf-8'\)", 'cached'

    # Fix 2: cache.set() signature - find and fix patterns
    # Pattern: await this.cache.set(cacheKey, dataStr, options.ttl || NUMBER, 'utf-8');
    $content = $content -replace "await this\.cache\.set\((\w+), (\w+), .*?, 'utf-8'\);", @'
const dataSize = $2.length;
      await this.cache.set($1, $2, dataSize, dataSize);
'@

    # Fix similar pattern without 'utf-8'
    $content = $content -replace "await this\.cache\.set\((\w+), (\w+), options\.ttl \|\| \d+\);", @'
const dataSize = $2.length;
      await this.cache.set($1, $2, dataSize, dataSize);
'@

    # Save the file
    Set-Content -Path $file -Value $content -NoNewline

    Write-Host "Fixed $file"
}

Write-Host "All files processed!"
