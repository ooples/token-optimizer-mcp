# Read Cache Interceptor Handler
# Implements real-time caching for Read tool operations to save 250-350K tokens
# Strategy: Two-tier caching with in-memory hashtable + persistent JSON file
# Cache invalidation: LastWriteTime check on every cache hit

param([string]$Phase = "PreToolUse")

$CACHE_FILE = "C:\Users\yolan\.claude-global\hooks\data\read-cache.json"
$CACHE_DIR = "C:\Users\yolan\.claude-global\hooks\data"
$LOG_FILE = "C:\Users\yolan\.claude-global\hooks\logs\read-cache.log"

# Initialize global cache if not already loaded
if (-not $global:ReadCache) {
    $global:ReadCache = @{}
    $global:CacheDirty = $false
    $global:CacheStats = @{
        Hits = 0
        Misses = 0
        Stale = 0
        TokensSaved = 0
    }
}

function Write-CacheLog {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    try {
        $logEntry | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Silently fail if log write fails
    }
}

function Get-CanonicalPath {
    param([string]$Path)
    try {
        # Resolve-Path handles relative paths, symlinks, etc.
        # ProviderPath ensures we get filesystem path
        # ToLower() standardizes case for Windows
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath.ToLower()
        return $resolved
    } catch {
        # If path doesn't exist yet, normalize what we have
        return [System.IO.Path]::GetFullPath($Path).ToLower()
    }
}

function Load-PersistentCache {
    if (Test-Path $CACHE_FILE) {
        try {
            $jsonContent = Get-Content $CACHE_FILE -Raw -ErrorAction Stop
            $deserialized = $jsonContent | ConvertFrom-Json

            # Convert to hashtable for fast lookups
            $newCache = @{}
            foreach ($item in $deserialized) {
                # Parse LastWriteTime as DateTime
                $lastWriteTime = [DateTime]::Parse($item.Value.LastWriteTime)

                $newCache[$item.Key] = @{
                    Content = $item.Value.Content
                    LastWriteTime = $lastWriteTime
                    Tokens = $item.Value.Tokens
                    OriginalSize = $item.Value.OriginalSize
                    AccessCount = $item.Value.AccessCount
                    FirstAccessed = [DateTime]::Parse($item.Value.FirstAccessed)
                }
            }

            $global:ReadCache = $newCache
            Write-CacheLog "Loaded $($global:ReadCache.Count) items from persistent cache"
        } catch {
            Write-CacheLog "Failed to load persistent cache: $($_.Exception.Message)" "WARN"
            $global:ReadCache = @{}
        }
    }
}

function Save-PersistentCache {
    if ($global:CacheDirty) {
        try {
            # Ensure directory exists
            if (-not (Test-Path $CACHE_DIR)) {
                New-Item -ItemType Directory -Path $CACHE_DIR -Force | Out-Null
            }

            # Convert hashtable to array for JSON serialization
            $savable = $global:ReadCache.GetEnumerator() | ForEach-Object {
                @{
                    Key = $_.Key
                    Value = @{
                        Content = $_.Value.Content
                        LastWriteTime = $_.Value.LastWriteTime.ToString("o")
                        Tokens = $_.Value.Tokens
                        OriginalSize = $_.Value.OriginalSize
                        AccessCount = $_.Value.AccessCount
                        FirstAccessed = $_.Value.FirstAccessed.ToString("o")
                    }
                }
            }

            $savable | ConvertTo-Json -Depth 10 | Out-File $CACHE_FILE -Encoding UTF8
            $global:CacheDirty = $false
            Write-CacheLog "Saved cache to disk ($($global:ReadCache.Count) items)"
        } catch {
            Write-CacheLog "Failed to save persistent cache: $($_.Exception.Message)" "WARN"
        }
    }
}

function Get-TokenCount {
    param([string]$Content)
    # Approximate token count: ~4 chars per token for English text
    return [Math]::Ceiling($Content.Length / 4)
}

try {
    # Read JSON input from stdin
    $input_json = [Console]::In.ReadToEnd()

    if (-not $input_json) {
        Write-CacheLog "No JSON input received" "ERROR"
        exit 0
    }

    $data = $input_json | ConvertFrom-Json
    $toolName = $data.tool_name

    # Only handle Read tool
    if ($toolName -ne "Read") {
        exit 0
    }

    # Load persistent cache on first Read operation
    if ($global:ReadCache.Count -eq 0) {
        Load-PersistentCache
    }

    # Extract file path from tool input
    $filePath = $data.tool_input.file_path

    if (-not $filePath) {
        Write-CacheLog "No file_path in Read tool input" "WARN"
        exit 0
    }

    $canonicalPath = Get-CanonicalPath -Path $filePath
    Write-CacheLog "Processing Read for: $canonicalPath"

    if ($Phase -eq "PreToolUse") {
        # ===== CACHE CHECK LOGIC =====

        if ($global:ReadCache.ContainsKey($canonicalPath)) {
            $cachedItem = $global:ReadCache[$canonicalPath]

            # Check if file still exists
            if (-not (Test-Path -LiteralPath $filePath)) {
                Write-CacheLog "CACHE INVALID: File no longer exists: $canonicalPath" "WARN"
                $global:ReadCache.Remove($canonicalPath)
                $global:CacheDirty = $true
                exit 0  # Allow Read to proceed and fail naturally
            }

            $fileInfo = Get-Item -LiteralPath $filePath -ErrorAction Stop

            # ===== CACHE INVALIDATION CHECK =====
            if ($fileInfo.LastWriteTime -le $cachedItem.LastWriteTime) {
                # CACHE HIT - Return cached content and BLOCK Read tool
                $global:CacheStats.Hits++
                $cachedItem.AccessCount++
                $global:CacheDirty = $true

                $tokensSaved = $cachedItem.Tokens
                $global:CacheStats.TokensSaved += $tokensSaved

                Write-CacheLog "CACHE HIT: $canonicalPath (saved $tokensSaved tokens, access count: $($cachedItem.AccessCount))" "INFO"

                # BLOCK the Read tool and return cached content
                # Use stopReason to provide the cached content back to Claude
                $blockResponse = @{
                    continue = $false
                    stopReason = "CACHE_HIT: Using cached content for $filePath (saved $tokensSaved tokens)"
                    hookSpecificOutput = @{
                        hookEventName = "PreToolUse"
                        permissionDecision = "deny"
                        permissionDecisionReason = "File content available in cache"
                        handlerName = "ReadCacheInterceptor"
                        cachedContent = $cachedItem.Content
                        cacheStats = @{
                            hits = $global:CacheStats.Hits
                            misses = $global:CacheStats.Misses
                            stale = $global:CacheStats.Stale
                            tokensSaved = $global:CacheStats.TokensSaved
                            hitRate = if (($global:CacheStats.Hits + $global:CacheStats.Misses) -gt 0) {
                                [Math]::Round(($global:CacheStats.Hits / ($global:CacheStats.Hits + $global:CacheStats.Misses)) * 100, 2)
                            } else { 0 }
                        }
                    }
                } | ConvertTo-Json -Depth 10 -Compress

                Write-Output $blockResponse

                # Periodically save cache to disk (every 20 operations)
                if (($global:CacheStats.Hits % 20) -eq 0) {
                    Save-PersistentCache
                }

                exit 2  # Exit code 2 = block tool
            } else {
                # CACHE STALE - File has been modified
                $global:CacheStats.Stale++
                Write-CacheLog "CACHE STALE: $canonicalPath (file modified at $($fileInfo.LastWriteTime), cache from $($cachedItem.LastWriteTime))" "INFO"
                # Remove stale entry and allow Read to proceed
                $global:ReadCache.Remove($canonicalPath)
                $global:CacheDirty = $true
                exit 0  # Allow Read to proceed
            }
        } else {
            # CACHE MISS - Allow Read to proceed
            $global:CacheStats.Misses++
            Write-CacheLog "CACHE MISS: $canonicalPath (total misses: $($global:CacheStats.Misses))" "INFO"
            exit 0  # Allow Read to proceed
        }

    } elseif ($Phase -eq "PostToolUse") {
        # ===== CACHE STORAGE LOGIC =====

        # Only store if Read was successful
        if ($data.tool_result -and $data.tool_result.content) {
            # Extract actual content from the Read tool result
            $content = ""
            foreach ($contentBlock in $data.tool_result.content) {
                if ($contentBlock.type -eq "text") {
                    $content += $contentBlock.text
                }
            }

            if ($content) {
                $fileInfo = Get-Item -LiteralPath $filePath -ErrorAction SilentlyContinue

                if ($fileInfo) {
                    $tokenCount = Get-TokenCount -Content $content

                    $newCacheEntry = @{
                        Content = $content
                        LastWriteTime = $fileInfo.LastWriteTime
                        Tokens = $tokenCount
                        OriginalSize = $fileInfo.Length
                        AccessCount = 1
                        FirstAccessed = Get-Date
                    }

                    $global:ReadCache[$canonicalPath] = $newCacheEntry
                    $global:CacheDirty = $true

                    Write-CacheLog "CACHED: $canonicalPath ($tokenCount tokens, $($fileInfo.Length) bytes)" "INFO"

                    # Periodically save cache (every 20 operations)
                    if (($global:ReadCache.Count % 20) -eq 0) {
                        Save-PersistentCache
                    }
                }
            }
        }

        exit 0
    }

} catch {
    Write-CacheLog "Cache interceptor failed: $($_.Exception.Message)" "ERROR"
    Write-CacheLog "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    exit 0  # Allow Read to proceed on error
}
