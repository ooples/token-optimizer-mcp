# Token Optimizer Orchestrator
# Unified handler for ALL token optimization operations
# Replaces 15+ fragmented PowerShell handlers with direct MCP calls

# Accept Phase, Action, and InputJsonFile (temp file path) from dispatcher
# NOT marked as Mandatory to avoid stdin consumption issues
param(
    [string]$Phase = "",
    [string]$Action = "",
    [string]$InputJsonFile = ""
)

# Dot-source helpers BEFORE any logging — Write-Log must exist before
# the first use below.
#
# Resolve every path relative to THIS script so the hooks work for any
# user and any install location. NEVER hardcode a developer profile
# (e.g. C:\Users\cheat\...) — that breaks the hooks for everyone else.
# This script lives in <hooks-root>\handlers, so the hooks root is the
# parent of $PSScriptRoot.
$HOOKS_ROOT = Split-Path -Parent $PSScriptRoot
$HELPERS_DIR = Join-Path $HOOKS_ROOT "helpers"
$INVOKE_MCP = Join-Path $HELPERS_DIR "invoke-mcp.ps1"
$LOG_FILE = Join-Path $HOOKS_ROOT "logs\token-optimizer-orchestrator.log"
$OPERATIONS_DIR = Join-Path $HOOKS_ROOT "data"
# $SESSION_FILE is resolved per-session below, once the hook payload
# (which carries the real Claude Code session_id) has been read.
. (Join-Path $HELPERS_DIR "logging.ps1")
. (Join-Path $HELPERS_DIR "config.ps1")
. (Join-Path $HELPERS_DIR "gzip.ps1")
. (Join-Path $HELPERS_DIR "context-delta.ps1")

# DIAGNOSTIC: Log script version/load time to verify latest version is being used
$SCRIPT_VERSION = Get-Date -Format 'yyyyMMdd.HHmmss'
Write-Log "token-optimizer-orchestrator.ps1 version $SCRIPT_VERSION loaded. Phase=$Phase, Action=$Action" "DEBUG"

# Read JSON from temp file if provided
# DO NOT delete temp file - dispatcher will clean it up after all handlers run
$InputJson = ""
if ($InputJsonFile -and (Test-Path $InputJsonFile)) {
    try {
        $InputJson = Get-Content -Path $InputJsonFile -Raw -Encoding UTF8
    } catch {
        Write-Log "Failed to read InputJsonFile: $($_.Exception.Message)" "ERROR"
    }
}
# Resolve the session file from the REAL Claude Code session id carried in
# the hook payload (field: session_id). Keying state per-session stops
# concurrent/sequential Claude Code sessions from sharing one counter file,
# and lets get_session_stats / transcript analytics match on the same id.
# Falls back to a shared default only when the payload carries no session id.
$SessionId = $null
if ($InputJson) {
    try {
        $SessionId = ($InputJson | ConvertFrom-Json).session_id
    } catch {
        $SessionId = $null
    }
}
if ($SessionId) {
    # Strip anything that isn't filename-safe.
    $safeSessionId = ($SessionId -replace '[^A-Za-z0-9._-]', '_')
    $SESSION_FILE = Join-Path $OPERATIONS_DIR "session-$safeSessionId.txt"
} else {
    $SESSION_FILE = Join-Path $OPERATIONS_DIR "current-session.txt"
}
# Ensure the data directory exists before any session read/write.
if (-not (Test-Path $OPERATIONS_DIR)) {
    New-Item -ItemType Directory -Path $OPERATIONS_DIR -Force | Out-Null
}

# PERFORMANCE FIX: Prefer local dev path if not already set.
# NOTE: $HOME is a read-only PowerShell automatic variable — assigning to it
# throws "Cannot overwrite variable HOME". Use a distinct local name.
if (-not $env:TOKEN_OPTIMIZER_DEV_PATH) {
  $profileHome = $env:USERPROFILE; if (-not $profileHome) { $profileHome = (Get-Item "~").FullName }
  $env:TOKEN_OPTIMIZER_DEV_PATH = (Join-Path $profileHome "source\repos\token-optimizer-mcp")
}

# PERFORMANCE OPTIMIZATION: In-memory session state (50-70ms -> <10ms)
# Reduces disk I/O overhead by keeping session state in memory
# Use TOKEN_OPTIMIZER_USE_FILE_SESSION=true to revert to file-based behavior
$script:CurrentSession = $null
$script:OperationLogBuffer = @()
$script:FlushTimer = $null
$script:BATCH_SIZE = 100
$script:BATCH_INTERVAL_MS = 5000

# Token budget configuration
$CONTEXT_LIMIT = 200000
$OPTIMIZE_THRESHOLD = 0.80
$FORCE_THRESHOLD = 0.90

# Optimization quality configuration
$OPTIMIZATION_QUALITY = 11  # Maximum compression quality

# Cache key hash configuration
$HASH_PREFIX = "hash:"
$HASH_LENGTH = 32

# =============================================================================
# LRU CACHE CLASSES (Issue #5)
# =============================================================================
# Guard against class re-definition on subsequent script loads
if (-not ('LruCacheEntry' -as [type])) {
    class LruCacheEntry {
        [object]$Value
        [datetime]$Timestamp

        LruCacheEntry([object]$value) {
            $this.Value = $value
            $this.Timestamp = Get-Date
        }
    }
}

if (-not ('LruCache' -as [type])) {
    class LruCache {
    [System.Collections.Specialized.OrderedDictionary]$Cache
    [int]$MaxSize
    [int]$TtlSeconds
    [int]$HitCount = 0
    [int]$MissCount = 0
    [int]$EvictionCount = 0

    LruCache([int]$maxSize, [int]$ttlSeconds) {
        $this.Cache = [System.Collections.Specialized.OrderedDictionary]::new()
        $this.MaxSize = $maxSize
        $this.TtlSeconds = $ttlSeconds
    }

    # Get value from cache (returns $null if not found or expired)
    [object] Get([string]$key) {
        if (-not $this.Cache.Contains($key)) {
            $this.MissCount++
            return $null
        }

        $entry = $this.Cache[$key]

        # Check TTL expiration
        if ($this.TtlSeconds -gt 0) {
            $age = ((Get-Date) - $entry.Timestamp).TotalSeconds
            if ($age -gt $this.TtlSeconds) {
                $this.Cache.Remove($key)
                $this.MissCount++
                $this.EvictionCount++
                return $null
            }
        }

        # Move to end (most recently used) by removing and re-adding
        $value = $entry.Value
        $this.Cache.Remove($key)
        $this.Cache[$key] = [LruCacheEntry]::new($value)

        $this.HitCount++
        return $value
    }

    # Set value in cache
    [void] Set([string]$key, [object]$value) {
        # Remove if already exists (to re-insert at end)
        if ($this.Cache.Contains($key)) {
            $this.Cache.Remove($key)
        }

        # Evict least recently used if at capacity
        if ($this.Cache.Count -ge $this.MaxSize) {
            # First key is least recently used (OrderedDictionary maintains insertion order)
            $firstKey = @($this.Cache.Keys)[0]
            $this.Cache.Remove($firstKey)
            $this.EvictionCount++
        }

        # Insert at end (most recently used)
        $this.Cache[$key] = [LruCacheEntry]::new($value)
    }

    # Check if key exists and is not expired
    [bool] ContainsKey([string]$key) {
        return $null -ne $this.Get($key)
    }

    # Clear all entries
    [void] Clear() {
        $this.Cache.Clear()
        $this.HitCount = 0
        $this.MissCount = 0
        $this.EvictionCount = 0
    }

    # Get cache statistics
    [hashtable] GetStats() {
        $totalRequests = $this.HitCount + $this.MissCount
        return @{
            Size = $this.Cache.Count
            MaxSize = $this.MaxSize
            HitCount = $this.HitCount
            MissCount = $this.MissCount
            EvictionCount = $this.EvictionCount
            HitRate = if ($totalRequests -gt 0) {
                [Math]::Round(($this.HitCount / $totalRequests) * 100, 2)
            } else { 0 }
        }
    }

    # Cleanup expired entries (call periodically)
    [int] CleanupExpired() {
        if ($this.TtlSeconds -le 0) { return 0 }

        $removed = 0
        $keysToRemove = @()

        foreach ($key in $this.Cache.Keys) {
            $entry = $this.Cache[$key]
            $age = ((Get-Date) - $entry.Timestamp).TotalSeconds
            if ($age -gt $this.TtlSeconds) {
                $keysToRemove += $key
            }
        }

        foreach ($key in $keysToRemove) {
            $this.Cache.Remove($key)
            $removed++
        }

        $this.EvictionCount += $removed
        return $removed
    }
}
}

# =============================================================================
# TOKEN COUNTER CLASS (Issue #4)
# =============================================================================
if (-not ('TokenCounter' -as [type])) {
    class TokenCounter {
    [string]$ApiKey
    [string]$Model
    [LruCache]$Cache
    [int]$ApiCallCount = 0
    [int]$CacheHitCount = 0
    [int]$EstimationCount = 0

    TokenCounter([string]$apiKey, [string]$model) {
        $this.ApiKey = $apiKey
        $this.Model = $model
        # Use LRU cache: Max 200 entries, TTL 30 minutes (1800 seconds)
        $this.Cache = [LruCache]::new(200, 1800)
    }

    # Primary method: try API first, fall back to estimation
    [int] CountTokens([string]$text, [string]$contentType) {
        # Check cache first (using content hash as key with proper disposal).
        # Initialize $textHash before the try so PowerShell's class definite-
        # assignment analysis sees it assigned on every path (otherwise the
        # whole file fails to parse: "Variable is not assigned in the method").
        $textHash = ""
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $textHash = [System.BitConverter]::ToString(
                $sha256.ComputeHash(
                    [System.Text.Encoding]::UTF8.GetBytes($text)
                )
            ).Replace("-", "")
        } finally {
            $sha256.Dispose()
        }
        $cacheKey = "${contentType}:${textHash}"

        $cached = $this.Cache.Get($cacheKey)
        if ($null -ne $cached) {
            $this.CacheHitCount++
            return $cached
        }

        # Try API call if key is available
        if ($this.ApiKey) {
            try {
                $tokenCount = $this.CountTokensViaAPI($text)
                $this.ApiCallCount++
                $this.Cache.Set($cacheKey, $tokenCount)
                return $tokenCount
            } catch {
                # API failed, fall back to estimation (use Write-Host since Write-Log defined later)
                Write-Host "WARN: Token counting API failed: $($_.Exception.Message), falling back to estimation" -ForegroundColor Yellow
            }
        }

        # Fallback to improved estimation
        $estimated = $this.EstimateTokens($text, $contentType)
        $this.EstimationCount++
        $this.Cache.Set($cacheKey, $estimated)
        return $estimated
    }

    # Google AI API integration
    [int] CountTokensViaAPI([string]$text) {
        $requestBody = @{
            contents = @(
                @{
                    parts = @(
                        @{
                            text = $text
                        }
                    )
                }
            )
        } | ConvertTo-Json -Depth 10 -Compress

        $uri = "https://generativelanguage.googleapis.com/v1beta/models/$($this.Model):countTokens?key=$($this.ApiKey)"

        try {
            $response = Invoke-RestMethod -Uri $uri -Method POST -ContentType "application/json" -Body $requestBody -TimeoutSec 5
        } catch {
            $ex = $_.Exception
            if ($ex -is [System.Net.WebException]) {
                if ($ex.Status -eq [System.Net.WebExceptionStatus]::Timeout) {
                    throw "Token counting API timeout after 5 seconds"
                } elseif ($ex.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) {
                    throw "Token counting API network error (connect failure)"
                } else {
                    throw "Token counting API network error: $($ex.Status)"
                }
            } else {
                throw
            }
        }

        return $response.totalTokens
    }

    # Improved estimation with content-type awareness
    [int] EstimateTokens([string]$text, [string]$contentType) {
        $baseRatio = [Math]::Ceiling($text.Length / 4.0)

        switch ($contentType) {
            "code" {
                # Code has more tokens per character due to symbols/keywords
                return [Math]::Ceiling($baseRatio * 1.2)
            }
            "json" {
                # JSON structures add token overhead for delimiters
                return [Math]::Ceiling($baseRatio * 1.15)
            }
            "markdown" {
                # Markdown formatting adds token overhead
                return [Math]::Ceiling($baseRatio * 1.1)
            }
            "text" {
                # Plain text is slightly less than base ratio
                return [Math]::Ceiling($baseRatio * 0.95)
            }
            default {
                return $baseRatio
            }
        }
        # Unreachable (the switch has a default), but PowerShell's class method
        # analysis does not treat a switch as exhaustive, so without a trailing
        # return the whole file fails to parse: "Not all code path returns
        # value within method".
        return $baseRatio
    }

    # Content type detection based on file extension or tool name
    [string] DetectContentType([string]$identifier) {
        switch -Regex ($identifier) {
            '\.(cs|ps1|ts|js|py|java|cpp|c|h|go|rs|rb|php)$' { return "code" }
            '\.(json|jsonc)$' { return "json" }
            '\.(md|markdown)$' { return "markdown" }
            '^(Read|Grep|Bash)$' { return "code" }
            default { return "text" }
        }
        # Guaranteed return so the class parses (see EstimateTokens above).
        return "text"
    }

    # Get cache statistics
    [hashtable] GetStats() {
        $cacheStats = $this.Cache.GetStats()
        $totalCalls = $this.ApiCallCount + $this.EstimationCount
        return @{
            ApiCalls = $this.ApiCallCount
            CacheHits = $this.CacheHitCount
            EstimationCount = $this.EstimationCount
            CacheSize = $cacheStats.Size
            CacheHitRate = $cacheStats.HitRate
            TotalCalls = $totalCalls
        }
    }
}
}

# Initialize global TokenCounter (singleton pattern)
if (-not $script:TokenCounter) {
    $apiKey = $env:GOOGLE_AI_API_KEY
    if (-not $apiKey) {
        Write-Log "GOOGLE_AI_API_KEY not set, falling back to estimation only" "WARN"
    }
    $modelName = if ($env:GOOGLE_AI_MODEL) { $env:GOOGLE_AI_MODEL } else { "gemini-2.0-flash-exp" }
    $script:TokenCounter = [TokenCounter]::new($apiKey, $modelName)
}

# PHASE 2 FIX: Deterministic cache key generation
# Fixes 0% cache hit rate by ensuring identical operations produce identical keys
function Get-DeterministicCacheKey {
    param(
        [string]$ToolName,
        [hashtable]$ToolArgs
    )

    # Create canonical representation
    $canonical = @{
        tool = $ToolName
        args = @{}
    }

    # Sort keys and normalize values
    foreach ($key in ($ToolArgs.Keys | Sort-Object)) {
        $value = $ToolArgs[$key]

        # Normalize file paths (absolute, lowercase, forward slashes)
        if ($key -match 'path|file') {
            try {
                $value = [System.IO.Path]::GetFullPath($value).ToLower().Replace('\', '/')
            } catch {
                # If path resolution fails, use as-is
            }
        }

        # Hash large content instead of embedding (prevents unique keys for every variation)
        if ($value -is [string] -and $value.Length -gt 1000) {
            $hasher = [System.Security.Cryptography.SHA256]::Create()
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($value)
            $hashBytes = $hasher.ComputeHash($bytes)
            $value = $script:HASH_PREFIX + [Convert]::ToBase64String($hashBytes).Substring(0, $script:HASH_LENGTH)
        }

        $canonical.args[$key] = $value
    }

    # Convert to deterministic JSON (determinism ensured by manually sorting keys before ConvertTo-Json)
    $json = $canonical | ConvertTo-Json -Depth 10 -Compress

    # Hash the entire key for fixed length (prevents extremely long keys)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $keyBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $hashBytes = $hasher.ComputeHash($keyBytes)
    return [Convert]::ToBase64String($hashBytes).Substring(0, $script:HASH_LENGTH)
}

# Helper function to read session from file with locking
function Read-SessionFile {
    param([string]$FilePath)
    $maxRetries = 5
    $retryDelayMs = 100
    for ($i = 0; $i -lt $maxRetries; $i++) {
        try {
            # Open file with exclusive read access (no other process can open it)
            $fileStream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
            try {
                $reader = New-Object System.IO.StreamReader($fileStream)
                $content = $reader.ReadToEnd()
                return $content | ConvertFrom-Json
            } finally {
                $fileStream.Close()
                $fileStream.Dispose()
            }
        } catch [System.IO.IOException] {
            Write-Log "Failed to acquire read lock on session file '$FilePath', retrying... ($($_.Exception.Message))" "WARN"
            Start-Sleep -Milliseconds $retryDelayMs
        } catch {
            Handle-Error -Exception $_.Exception -Message "Failed to read session file '$FilePath'"
            return $null
        }
    }
    Write-Log "Failed to read session file '$FilePath' after multiple retries due to locking." "ERROR"
    return $null
}

# Helper function to write session to file with locking
function Write-SessionFile {
    param(
        [string]$FilePath,
        $SessionObject  # Accept any object type (hashtable or PSCustomObject)
    )
    $maxRetries = 5
    $retryDelayMs = 100
    for ($i = 0; $i -lt $maxRetries; $i++) {
        $fileStream = $null # Initialize to null for proper finally handling
        $writer = $null # Initialize to null for proper finally handling
        try {
            # Open file with exclusive write access (creates or overwrites)
            $fileStream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $writer = New-Object System.IO.StreamWriter($fileStream)
            $json = $SessionObject | ConvertTo-Json -Depth 100 # Increased depth for robustness
            $writer.Write($json)
            $writer.Flush() # Ensure all buffered data is written
            $writer.Close() # Close the writer
            return $true
        } catch [System.IO.IOException] {
            Write-Log "Failed to acquire write lock on session file '$FilePath', retrying... ($($_.Exception.Message))" "WARN"
            Start-Sleep -Milliseconds $retryDelayMs
        } catch {
            Handle-Error -Exception $_.Exception -Message "Failed to write session file '$FilePath'"
            return $false
        } finally {
            # Ensure writer and fileStream are disposed even if errors occur
            if ($writer) {
                $writer.Dispose()
            }
            if ($fileStream) {
                $fileStream.Close()
                $fileStream.Dispose()
            }
        }
    }
    Write-Log "Failed to write session file '$FilePath' after multiple retries due to locking." "ERROR"
    return $false
}

function Flush-OperationLogs {
    # Flush buffered operation logs to disk
    param([switch]$Force)

    $syncWrites = $env:TOKEN_OPTIMIZER_SYNC_LOG_WRITES -eq 'true'

    if ($script:OperationLogBuffer.Count -eq 0) {
        return
    }

    # Flush if forced, batch size reached, or sync writes enabled
    if ($Force -or $syncWrites -or $script:OperationLogBuffer.Count -ge $script:BATCH_SIZE) {
        try {
            $session = if ($script:CurrentSession) { $script:CurrentSession } else { Get-SessionInfo }
            if (-not $session) { return }

            $csvFile = "$OPERATIONS_DIR\operations-$($session.sessionId).csv"

            # Create file with header if needed
            if (-not (Test-Path $csvFile)) {
                "timestamp,toolName,tokens,metadata" | Out-File $csvFile -Encoding UTF8
            }

            # Append all buffered entries
            $script:OperationLogBuffer | Out-File $csvFile -Append -Encoding UTF8

            Write-Log "Flushed $($script:OperationLogBuffer.Count) operation logs" "DEBUG"
            $script:OperationLogBuffer = @()
        } catch {
            Handle-Error -Exception $_.Exception -Message "Failed to flush operation logs"
        }
    }
}

function Start-LogFlushTimer {
    # Start periodic timer to flush logs every 5 seconds
    if ($script:FlushTimer) { return }

    try {
        $script:FlushTimer = New-Object System.Timers.Timer
        $script:FlushTimer.Interval = $script:BATCH_INTERVAL_MS
        $script:FlushTimer.AutoReset = $true

        Register-ObjectEvent -InputObject $script:FlushTimer -EventName Elapsed -Action {
            Flush-OperationLogs
        } | Out-Null

        $script:FlushTimer.Start()
        Write-Log "Started log flush timer (interval: $($script:BATCH_INTERVAL_MS)ms)" "DEBUG"
    } catch {
        Write-Log "Failed to start flush timer: $($_.Exception.Message)" "WARN"
    }
}



# Removed - now using direct invoke-mcp.ps1 calls

function Get-SessionInfo {
    if (Test-Path $SESSION_FILE) {
        try {
            $session = Read-SessionFile -FilePath $SESSION_FILE
            return $session
        } catch {
            Handle-Error -Exception $_.Exception -Message "Failed to read session file"
        }
    }
    return $null
}

function Initialize-Session {
    # Always try to load from file first
    $session = Get-SessionInfo

    if (-not $session) {
        # If file doesn't exist or is empty/corrupt, create a new session.
        # Prefer the REAL Claude Code session id (parsed from the hook payload
        # into $script:SessionId) so operations-<sessionId>.csv and
        # get_session_stats line up with the actual session. Only mint a
        # random GUID when the payload carried no session id.
        $sessionId = if ($script:SessionId) { $script:SessionId } else { [guid]::NewGuid().ToString() }
        $sessionStart = Get-Date -Format "yyyyMMdd-HHmmss"

        # PHASE 4 FIX: Enhanced stats tracking
        $session = @{
            sessionId = $sessionId
            sessionStart = $sessionStart
            totalOperations = 0
            totalOriginalTokens = 0
            totalOptimizedTokens = 0
            totalTokensSaved = 0
            optimizationFailures = 0
            optimizationSuccesses = 0
            cacheHits = 0
            cacheMisses = 0
            totalTokens = 0
            lastOptimized = 0
        }

        # Write the newly created session to file
        if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $session) {
            Write-Log "Initialized new session: $sessionId (Phase 4 enhanced tracking)" "INFO"
        } else {
            Write-Log "Failed to write new session to file. Session state might not persist." "ERROR"
        }
    } else {
        Write-Log "Loaded existing session: $($session.sessionId)" "INFO"
    }

    # Populate the in-memory script:CurrentSession for the current process
    # This acts as a local cache for the current process's operations
    $script:CurrentSession = $session

    # CRITICAL: Ensure the session file is ALWAYS written after initialization
    # This guarantees multi-process persistence
    if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
        Write-Log "Session state written to file after initialization." "DEBUG"
    } else {
        Write-Log "Failed to write session state to file after initialization. Session state might not persist." "ERROR"
    }

    # Start log flush timer only once per process if not already started
    if (-not $script:FlushTimer) {
        Start-LogFlushTimer
    }

    return $script:CurrentSession
}

function Update-SessionOperation {
    param(
        [int]$TokensDelta = 0
        # Removed -Persist switch - now ALWAYS persists
    )

    # Ensure $script:CurrentSession is initialized for this process
    if (-not $script:CurrentSession) {
        $script:CurrentSession = Initialize-Session
    }

    $script:CurrentSession.totalOperations++
    $script:CurrentSession.totalTokens += $TokensDelta

    # CRITICAL: ALWAYS write to disk for persistence across processes
    if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
        Write-Log "Session state persisted to file (totalOperations: $($script:CurrentSession.totalOperations))." "DEBUG"
    } else {
        Write-Log "Failed to persist session state to file." "ERROR"
    }

    return $script:CurrentSession
}

function Handle-LogOperation {
    param([string]$InputJson)
    # Log ALL tool operations to operations-{sessionId}.csv for session-level optimization
    try {
        if (-not $InputJson) {
            Write-Log "No input received for operation logging" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $toolName = $data.tool_name

        $session = if ($script:CurrentSession) { $script:CurrentSession } else { Get-SessionInfo }
        if (-not $session) {
            Write-Log "No active session for operation logging" "WARN"
            return
        }

        # Extract file path and tokens for file-based operations
        $filePath = ""
        $tokens = 0
        $metadata = ""

        if ($toolName -eq "Read") {
            $filePath = $data.tool_input.file_path
            # Estimate tokens from response
            if ($data.tool_response -and $data.tool_response.file -and $data.tool_response.file.content) {
                $tokens = [Math]::Ceiling($data.tool_response.file.content.Length / 4)
            }
            $metadata = "filePath=$filePath"
        } elseif ($toolName -in @("Write", "Edit")) {
            $filePath = $data.tool_input.file_path
            $content = $data.tool_input.content
            if (-not $content) {
                $content = $data.tool_input.new_string
            }
            if ($content) {
                $tokens = [Math]::Ceiling($content.Length / 4)
            }
            $metadata = "filePath=$filePath"
        } else {
            # For other tools, log basic info
            $metadata = "toolName=$toolName"
        }

        # Build CSV line
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $csvLine = "$timestamp,$toolName,$tokens,`"$metadata`""

        # OPTIMIZED: Buffer in memory instead of immediate write
        $syncWrites = $env:TOKEN_OPTIMIZER_SYNC_LOG_WRITES -eq 'true'

        if ($syncWrites) {
            # Legacy mode: write immediately
            $csvFile = "$OPERATIONS_DIR\operations-$($session.sessionId).csv"
            if (-not (Test-Path $csvFile)) {
                "timestamp,toolName,tokens,metadata" | Out-File $csvFile -Encoding UTF8
            }
            $csvLine | Out-File $csvFile -Append -Encoding UTF8
        } else {
            # Batched mode: add to buffer
            $script:OperationLogBuffer += $csvLine

            # Flush if buffer is full
            if ($script:OperationLogBuffer.Count -ge $script:BATCH_SIZE) {
                Flush-OperationLogs
            }
        }

        Write-Log "Logged operation: $toolName ($tokens tokens)" "DEBUG"

    } catch {
        Handle-Error -Exception $_.Exception -Message "Operation logging failed"
    }
}

function Handle-OptimizeSession {
    # Run session-level batch optimization using optimize_session
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            Write-Log "No active session for optimization" "WARN"
            return
        }

        Write-Log "Running session-level optimization for session: $($session.sessionId)" "INFO"

        # Call optimize_session MCP tool
        $mcpArgs = @{
            sessionId = $session.sessionId
            min_token_threshold = 30
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_session" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result) {
            Write-Log "Session optimization completed: $($result.operationsCompressed) files optimized, $($result.tokens.saved) tokens saved ($($result.tokens.percentSaved)% reduction)" "INFO"
            Write-Log "Detailed stats: Before=$($result.tokens.before) After=$($result.tokens.after) Saved=$($result.tokens.saved)" "INFO"
        }

    } catch {
        Handle-Error -Exception $_.Exception -Message "Session optimization failed"
    }
}

function Handle-ContextGuard {
    param([string]$InputJson)
    # Check context budget and trigger optimization if needed
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            return 0
        }

        $percentage = $session.totalTokens / $CONTEXT_LIMIT

        Write-Log "Context usage: $($session.totalTokens) / $CONTEXT_LIMIT ($([Math]::Round($percentage * 100, 1))%)" "DEBUG"

        if ($percentage -ge $FORCE_THRESHOLD) {
            Write-Log "CRITICAL: Context exhaustion at $([Math]::Round($percentage * 100, 1))%" "ERROR"

            # FORCE optimization
            $mcpArgs = @{
                sessionId = $session.sessionId
                min_token_threshold = 30
            }
            $argsJson = $mcpArgs | ConvertTo-Json -Compress
            $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_session" -ArgumentsJson $argsJson
            $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

            if ($result) {
                Write-Log "Emergency optimization completed" "INFO"
                $session.lastOptimized = $session.totalOperations
                $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
            } else {
                # Signal the dispatcher to block (exit 2). Do NOT write a
                # response here: the dispatcher owns the block and emits the
                # correct PreToolUse deny schema via Block-Tool. Writing our own
                # JSON to stdout would leak into the dispatcher's stdout and
                # collide with Block-Tool's response.
                Write-Log "Context guard: optimize_session failed at FORCE_THRESHOLD - signalling block" "WARN"
                return 2
            }

        } elseif ($percentage -ge $OPTIMIZE_THRESHOLD) {
            # Check if we've optimized recently
            $opsSinceOptimize = $session.totalOperations - $session.lastOptimized

            if ($opsSinceOptimize -ge 20) {
                Write-Log "WARNING: Context at $([Math]::Round($percentage * 100, 1))% - triggering optimization" "WARN"

                $mcpArgs = @{
                    sessionId = $session.sessionId
                    min_token_threshold = 30
                }
                $argsJson = $mcpArgs | ConvertTo-Json -Compress
                $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_session" -ArgumentsJson $argsJson
                $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

                if ($result) {
                    Write-Log "Proactive optimization completed" "INFO"
                    $session.lastOptimized = $session.totalOperations
                    $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
                }
            }
        }

        return 0  # Success - allow operation to proceed

    } catch {
        Handle-Error -Exception $_.Exception -Message "Context guard failed"
        return 0  # On error, don't block
    }
}

function Handle-PeriodicOptimize {
    # Run optimize_session every 50 operations
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            return
        }

        Write-Log "Periodic optimization triggered at operation #$($session.totalOperations)" "INFO"

        $mcpArgs = @{
            sessionId = $session.sessionId
            min_token_threshold = 30
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_session" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result) {
            Write-Log "Periodic optimization completed. Summary: $($result.summary)" "INFO"
            $session.lastOptimized = $session.totalOperations
            $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
        }

    } catch {
        Handle-Error -Exception $_.Exception -Message "Periodic optimize failed"
    }
}

function Handle-CacheWarmup {
    # Pre-warm cache on session start using predictive cache
    try {
        Write-Log "Starting cache warmup" "INFO"

        # Use pattern-based warmup
        $mcpArgs = @{
            operation = "pattern-based"
            timeWindow = 3600000  # 1 hour
            minAccessCount = 2
            maxConcurrency = 5
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_warmup" -ArgumentsJson $argsJson
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        if ($result) {
            Write-Log "Cache warmup completed: $($result.keysWarmed) keys warmed" "INFO"
        }

    } catch {
        Handle-Error -Exception $_.Exception -Message "Cache warmup failed"
    }
}

function Handle-SessionReport {
    # Generate comprehensive session analytics
    try {
        $session = Get-SessionInfo
        if (-not $session) {
            return
        }

        Write-Log "Generating session report for session: $($session.sessionId)" "INFO"

        # Get session stats
        $mcpArgs = @{
            sessionId = $session.sessionId
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        $statsJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "get_session_stats" -ArgumentsJson $argsJson
        $stats = if ($statsJson) { $statsJson | ConvertFrom-Json } else { $null }

        if ($stats) {
            Write-Log "Session stats: $($stats | ConvertTo-Json -Compress)" "INFO"

            # Generate project-level analysis
            $mcpArgs = @{
                projectPath = $HOOKS_ROOT
                costPerMillionTokens = 30
            }
            $argsJson = $mcpArgs | ConvertTo-Json -Compress
            $analysisJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "analyze_project_tokens" -ArgumentsJson $argsJson
            $analysis = if ($analysisJson) { $analysisJson | ConvertFrom-Json } else { $null }

            if ($analysis) {
                Write-Log "Project analysis: Total tokens: $($analysis.totalTokens), Estimated cost: `$$($analysis.estimatedCost)" "INFO"
            }
        }

    } catch {
        Handle-Error -Exception $_.Exception -Message "Session report failed"
    }
}

function Handle-UserPromptOptimization {
    param([string]$InputJson)
    # PHASE 2: UserPromptSubmit - Optimize user prompt before processing
    # Uses: count_tokens, optimize_text, predictive_cache, natural-language-query
    try {
        if (-not $InputJson) {
            Write-Log "No input received for prompt optimization" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $userPrompt = if ($data.user_prompt) { $data.user_prompt } else { "" }

        if (-not $userPrompt) {
            Write-Log "No user prompt to optimize" "DEBUG"
            return
        }

        Write-Log "Optimizing user prompt" "INFO"

        # Count tokens in original prompt
        $beforeTokens = 0
        try {
            $countArgs = @{ text = $userPrompt }
            $countJson = $countArgs | ConvertTo-Json -Compress
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            $countData = if ($countResult) { $countResult | ConvertFrom-Json } else { $null }
            if ($countData -and $countData.content) {
                $beforeTokens = [int]($countData.content[0].text)
            }
        } catch {
            Write-Log "Prompt token counting failed: $($_.Exception.Message)" "WARN"
        }

        # Check predictive cache
        try {
            $cacheArgs = @{
                operation = "predict"
                modelType = "hybrid"
                maxPredictions = 5
                confidence = 0.7
            }
            $cacheJson = $cacheArgs | ConvertTo-Json -Compress
            $cacheResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive_cache" -ArgumentsJson $cacheJson
        } catch {
            # Silent fail - cache is optional
        }

        # Optimize prompt (PHASE 4: Skip for small texts < 500 chars)
        if ($userPrompt.Length -lt 500) {
            Write-Log "Skipping optimization for small prompt ($($userPrompt.Length) chars)" "DEBUG"
            return
        }

        try {
            # PHASE 2 FIX: Use content hash instead of timestamp for cache key
            $hasher = [System.Security.Cryptography.SHA256]::Create()
            $hashBytes = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($userPrompt))
            $contentHash = [Convert]::ToBase64String($hashBytes).Substring(0, 16)

            $optimizeArgs = @{
                text = $userPrompt
                key = "user_prompt_$contentHash"
                quality = $script:OPTIMIZATION_QUALITY
            }
            $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
            $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson
            $optimizeData = if ($optimizeResult) { $optimizeResult | ConvertFrom-Json } else { $null }

            if ($optimizeData -and $optimizeData.content) {
                $afterTokens = if ($optimizeData.metadata -and $optimizeData.metadata.compressedTokens) {
                    $optimizeData.metadata.compressedTokens
                } else { $beforeTokens }
                $saved = $beforeTokens - $afterTokens
                $percent = if ($beforeTokens -gt 0) { [math]::Round(($saved / $beforeTokens) * 100, 1) } else { 0 }
                Write-Log "Optimized user prompt: $beforeTokens → $afterTokens tokens ($percent% reduction)" "INFO"
            }
        } catch {
            Handle-Error -Exception $_.Exception -Message "Prompt optimization failed"
        }

    } catch {
        Handle-Error -Exception $_.Exception -Message "UserPromptOptimization handler failed"
    }
}

function Handle-SessionStartInit {
    # PHASE 2: SessionStart - Initialize caching and monitoring
    # Uses: cache_warmup, get_session_stats, health_monitor
    try {
        Write-Log "Initializing session with Phase 2 optimizations" "INFO"

        # Initialize session
        $session = Initialize-Session
        Write-Log "Session initialized: $($session.sessionId)" "INFO"

        # Trigger cache warmup
        try {
            $warmupArgs = @{
                operation = "schedule"
                strategy = "progressive"
                batchSize = 50
                priority = "normal"
            }
            $warmupJson = $warmupArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_warmup" -ArgumentsJson $warmupJson
            Write-Log "Cache warmup scheduled" "INFO"
        } catch {
            Write-Log "Cache warmup failed: $($_.Exception.Message)" "WARN"
        }

        # Get cache stats
        try {
            $statsResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "get_cache_stats" -ArgumentsJson "{}"
            $statsData = if ($statsResult) { $statsResult | ConvertFrom-Json } else { $null }
            if ($statsData -and $statsData.content) {
                $stats = $statsData.content[0].text | ConvertFrom-Json
                Write-Log "Cache stats: Hit rate: $($stats.hitRate), Entries: $($stats.entries)" "INFO"
            }
        } catch {
            Write-Log "Failed to get cache stats: $($_.Exception.Message)" "WARN"
        }

        # Health monitor check
        try {
            $healthArgs = @{ operation = "check-health" }
            $healthJson = $healthArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "health_monitor" -ArgumentsJson $healthJson
            Write-Log "Health monitor check completed" "INFO"
        } catch {
            Write-Log "Health monitor failed: $($_.Exception.Message)" "WARN"
        }

    } catch {
        Handle-Error -Exception $_.Exception -Message "SessionStartInit handler failed"
    }
}

function Handle-SmartDiff {
    # PHASE 7: Generate compact diffs for file changes
    # Uses: smart_diff for efficient change representation
    param(
        [string]$Source = "HEAD",
        [string]$Target = "",
        [array]$Files = @()
    )

    try {
        Write-Log "Generating smart diff" "DEBUG"

        $diffArgs = @{
            source = $Source
        }

        if ($Target) {
            $diffArgs.target = $Target
        }

        if ($Files.Count -gt 0) {
            $diffArgs.files = $Files
        }

        $diffArgs.summaryOnly = $false
        $diffArgs.contextLines = 3

        $diffJson = $diffArgs | ConvertTo-Json -Compress -Depth 5
        $diffResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_diff" -ArgumentsJson $diffJson

        if ($diffResult) {
            $diffData = $diffResult | ConvertFrom-Json
            if ($diffData -and $diffData.content) {
                Write-Log "Smart diff generated" "DEBUG"
                return $diffData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "SmartDiff handler failed"
        return $null
    }
}

function Handle-SmartLogs {
    # PHASE 7: Process and optimize log outputs
    # Uses: smart_logs for log aggregation and filtering
    param(
        [array]$Sources = @(),
        [string]$Level = "all",
        [int]$Tail = 100
    )

    try {
        Write-Log "Processing smart logs" "DEBUG"

        $logsArgs = @{
            tail = $Tail
            level = $Level
        }

        if ($Sources.Count -gt 0) {
            $logsArgs.sources = $Sources
        }

        $logsJson = $logsArgs | ConvertTo-Json -Compress -Depth 5
        $logsResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_logs" -ArgumentsJson $logsJson

        if ($logsResult) {
            $logsData = $logsResult | ConvertFrom-Json
            if ($logsData -and $logsData.content) {
                Write-Log "Smart logs processed" "DEBUG"
                return $logsData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "SmartLogs handler failed"
        return $null
    }
}

function Handle-ToolSpecificOptimization {
    # PHASE 7: Apply tool-specific optimization based on tool type
    param(
        [string]$ToolName,
        [string]$ToolOutput
    )

    try {
        Write-Log "Applying tool-specific optimization for: $ToolName" "DEBUG"

        # API/Database tools - compress JSON responses
        if ($ToolName -match "^(smart_api_fetch|smart_database|smart_graphql|smart_rest|smart_sql|smart_schema)") {
            try {
                $compressed = Handle-CacheCompression -Data $ToolOutput -DataType "json"
                if ($compressed) {
                    return $compressed
                }
            } catch {
                # Fall through to default
            }
        }

        # Git/File operations - use diff format
        if ($ToolName -match "^(smart_diff|smart_status|smart_log|Read|Edit|Write)") {
            # Already optimized by smart_* tools
            return $ToolOutput
        }

        # Build/Test tools - summarize verbose output
        if ($ToolName -match "^(smart_build|smart_test|smart_lint|smart_typecheck)") {
            try {
                $summarized = Handle-IntelligentSummarization -Text $ToolOutput -Context "build"
                if ($summarized -and $summarized.Length -lt $ToolOutput.Length) {
                    return $summarized
                }
            } catch {
                # Fall through to default
            }
        }

        # Log tools - filter and aggregate
        if ($ToolName -match "^(smart_logs|log_dashboard)") {
            # Already optimized
            return $ToolOutput
        }

        # Default: apply general optimization
        return $ToolOutput

    } catch {
        Handle-Error -Exception $_.Exception -Message "ToolSpecificOptimization handler failed"
        return $ToolOutput
    }
}

function Handle-MetricCollector {
    # PHASE 6: Comprehensive metric collection
    # Uses: metric_collector for operation metrics
    param(
        [string]$Operation,
        [hashtable]$Query = @{}
    )

    try {
        Write-Log "Collecting metrics for operation: $Operation" "DEBUG"

        $metricArgs = @{
            operation = $Operation
        }

        if ($Query.Count -gt 0) {
            $metricArgs.query = $Query
        }

        $metricJson = $metricArgs | ConvertTo-Json -Compress -Depth 5
        $metricResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "metric_collector" -ArgumentsJson $metricJson

        if ($metricResult) {
            $metricData = $metricResult | ConvertFrom-Json
            if ($metricData -and $metricData.content) {
                Write-Log "Metrics collected: $($metricData.content[0].text)" "DEBUG"
                return $metricData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "MetricCollector handler failed"
        return $null
    }
}

function Handle-AlertManager {
    # PHASE 6: Alert management for optimization issues
    # Uses: alert_manager for threshold alerts
    param(
        [string]$Operation,
        [hashtable]$Config = @{}
    )

    try {
        Write-Log "Alert manager operation: $Operation" "DEBUG"

        $alertArgs = @{
            operation = $Operation
        }

        if ($Config.Count -gt 0) {
            foreach ($key in $Config.Keys) {
                $alertArgs[$key] = $Config[$key]
            }
        }

        $alertJson = $alertArgs | ConvertTo-Json -Compress -Depth 5
        $alertResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "alert_manager" -ArgumentsJson $alertJson

        if ($alertResult) {
            $alertData = $alertResult | ConvertFrom-Json
            if ($alertData -and $alertData.content) {
                Write-Log "Alert: $($alertData.content[0].text)" "INFO"
                return $alertData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "AlertManager handler failed"
        return $null
    }
}

function Handle-HealthMonitor {
    # PHASE 6: System health monitoring
    # Uses: health_monitor for system checks
    param(
        [string]$Operation = "check-health"
    )

    try {
        Write-Log "Health monitor: $Operation" "DEBUG"

        $healthArgs = @{
            operation = $Operation
        }
        $healthJson = $healthArgs | ConvertTo-Json -Compress -Depth 5
        $healthResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "health_monitor" -ArgumentsJson $healthJson

        if ($healthResult) {
            $healthData = $healthResult | ConvertFrom-Json
            if ($healthData -and $healthData.content) {
                Write-Log "Health status: $($healthData.content[0].text)" "DEBUG"
                return $healthData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "HealthMonitor handler failed"
        return $null
    }
}

function Handle-MonitoringIntegration {
    # PHASE 6: External monitoring platform integration
    # Uses: monitoring_integration for external dashboards
    param(
        [string]$Operation,
        [hashtable]$Connection = @{}
    )

    try {
        Write-Log "Monitoring integration: $Operation" "DEBUG"

        $monitorArgs = @{
            operation = $Operation
        }

        if ($Connection.Count -gt 0) {
            $monitorArgs.connection = $Connection
        }

        $monitorJson = $monitorArgs | ConvertTo-Json -Compress -Depth 5
        $monitorResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "monitoring_integration" -ArgumentsJson $monitorJson

        if ($monitorResult) {
            $monitorData = $monitorResult | ConvertFrom-Json
            if ($monitorData -and $monitorData.content) {
                Write-Log "Monitoring integration: $($monitorData.content[0].text)" "DEBUG"
                return $monitorData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "MonitoringIntegration handler failed"
        return $null
    }
}

function Handle-AnalyzeOptimization {
    # PHASE 6: Analyze optimization effectiveness
    # Uses: analyze_optimization for feedback
    param(
        [string]$Text
    )

    try {
        if (-not $Text) {
            return $null
        }

        Write-Log "Analyzing optimization effectiveness" "DEBUG"

        $analyzeArgs = @{
            text = $Text
        }
        $analyzeJson = $analyzeArgs | ConvertTo-Json -Compress -Depth 5
        $analyzeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "analyze_optimization" -ArgumentsJson $analyzeJson

        if ($analyzeResult) {
            $analyzeData = $analyzeResult | ConvertFrom-Json
            if ($analyzeData -and $analyzeData.content) {
                Write-Log "Optimization analysis: $($analyzeData.content[0].text)" "DEBUG"
                return $analyzeData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "AnalyzeOptimization handler failed"
        return $null
    }
}

function Handle-CacheAnalytics {
    # PHASE 5: Advanced cache analytics
    # Uses: cache_analytics for performance insights
    try {
        Write-Log "Running cache analytics" "DEBUG"

        $analyticsArgs = @{
            operation = "dashboard"
            metricTypes = @("performance", "usage", "efficiency")
        }
        $analyticsJson = $analyticsArgs | ConvertTo-Json -Compress -Depth 5
        $analyticsResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_analytics" -ArgumentsJson $analyticsJson

        if ($analyticsResult) {
            $analyticsData = $analyticsResult | ConvertFrom-Json
            if ($analyticsData -and $analyticsData.content) {
                Write-Log "Cache analytics: $($analyticsData.content[0].text)" "INFO"
                return $analyticsData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "CacheAnalytics handler failed"
        return $null
    }
}

function Handle-CacheOptimizer {
    # PHASE 5: Cache optimization recommendations
    # Uses: cache_optimizer for strategy recommendations
    try {
        Write-Log "Running cache optimizer" "DEBUG"

        $optimizerArgs = @{
            operation = "analyze"
            analysisWindow = 3600000
            objective = "balanced"
        }
        $optimizerJson = $optimizerArgs | ConvertTo-Json -Compress -Depth 5
        $optimizerResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_optimizer" -ArgumentsJson $optimizerJson

        if ($optimizerResult) {
            $optimizerData = $optimizerResult | ConvertFrom-Json
            if ($optimizerData -and $optimizerData.content) {
                Write-Log "Cache optimizer recommendations: $($optimizerData.content[0].text)" "DEBUG"
                return $optimizerData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "CacheOptimizer handler failed"
        return $null
    }
}

function Handle-CacheCompression {
    # PHASE 5: Advanced cache compression
    # Uses: cache_compression for optimal compression
    param(
        [string]$Data,
        [string]$DataType = "auto"
    )

    try {
        if (-not $Data -or $Data.Length -lt 100) {
            return $Data
        }

        Write-Log "Applying cache compression" "DEBUG"

        $compressionArgs = @{
            operation = "compress"
            data = $Data
            dataType = $DataType
            autoSelect = $true
        }
        $compressionJson = $compressionArgs | ConvertTo-Json -Compress -Depth 5
        $compressionResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_compression" -ArgumentsJson $compressionJson

        if ($compressionResult) {
            $compressionData = $compressionResult | ConvertFrom-Json
            if ($compressionData -and $compressionData.content) {
                Write-Log "Data compressed successfully" "DEBUG"
                return $compressionData.content[0].text
            }
        }

        return $Data

    } catch {
        Handle-Error -Exception $_.Exception -Message "CacheCompression handler failed"
        return $Data
    }
}

function Handle-CacheInvalidation {
    # PHASE 5: Intelligent cache invalidation
    # Uses: cache_invalidation for dependency-based invalidation
    param(
        [string]$Pattern,
        [string]$Mode = "lazy"
    )

    try {
        Write-Log "Running cache invalidation: $Pattern" "DEBUG"

        $invalidationArgs = @{
            operation = "invalidate-pattern"
            pattern = $Pattern
            mode = $Mode
        }
        $invalidationJson = $invalidationArgs | ConvertTo-Json -Compress -Depth 5
        & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "cache_invalidation" -ArgumentsJson $invalidationJson

        Write-Log "Cache invalidation completed for pattern: $Pattern" "DEBUG"

    } catch {
        Handle-Error -Exception $_.Exception -Message "CacheInvalidation handler failed"
    }
}

function Handle-SmartCache {
    # PHASE 5: Multi-tier smart caching
    # Uses: smart_cache for L1/L2/L3 tiered storage
    param(
        [string]$Operation,
        [string]$Key,
        [string]$Value = $null,
        [string]$Tier = "L1"
    )

    try {
        Write-Log "Smart cache $Operation for key: $Key" "DEBUG"

        $cacheArgs = @{
            operation = $Operation
            key = $Key
        }

        if ($Value) {
            $cacheArgs.value = $Value
            $cacheArgs.tier = $Tier
        }

        $cacheJson = $cacheArgs | ConvertTo-Json -Compress -Depth 5
        $cacheResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_cache" -ArgumentsJson $cacheJson

        if ($cacheResult) {
            $cacheData = $cacheResult | ConvertFrom-Json
            if ($cacheData -and $cacheData.content) {
                return $cacheData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "SmartCache handler failed"
        return $null
    }
}

function Handle-IntelligentSummarization {
    # PHASE 4: Intelligent summarization for large outputs
    # Uses: smart-summarization, pattern-recognition, predictive-analytics
    param(
        [string]$Text,
        [string]$Context = "general"
    )

    try {
        if (-not $Text -or $Text.Length -lt 500) {
            return $Text
        }

        Write-Log "Applying intelligent summarization (length: $($Text.Length))" "INFO"

        # Use smart-summarization tool
        try {
            $summarizeArgs = @{
                operation = "summarize"
                query = $Text
                data = @{
                    context = $Context
                    maxLength = 200
                }
            }
            $summarizeJson = $summarizeArgs | ConvertTo-Json -Compress -Depth 5
            $summarizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart-summarization" -ArgumentsJson $summarizeJson

            if ($summarizeResult) {
                $summarizeData = $summarizeResult | ConvertFrom-Json
                if ($summarizeData -and $summarizeData.content) {
                    $summarized = $summarizeData.content[0].text
                    Write-Log "Summarized from $($Text.Length) to $($summarized.Length) chars" "INFO"
                    return $summarized
                }
            }
        } catch {
            Write-Log "Summarization failed: $($_.Exception.Message)" "WARN"
        }

        return $Text

    } catch {
        Handle-Error -Exception $_.Exception -Message "IntelligentSummarization handler failed"
        return $Text
    }
}

function Handle-PatternRecognition {
    # PHASE 4: Pattern recognition for recurring data
    # Uses: pattern-recognition to identify and abstract patterns
    param(
        [string]$Text
    )

    try {
        if (-not $Text -or $Text.Length -lt 200) {
            return $null
        }

        Write-Log "Running pattern recognition" "DEBUG"

        # Detect patterns in the text
        try {
            $patternArgs = @{
                operation = "detect-patterns"
                query = $Text
                data = @{
                    minSupport = 2
                    confidence = 0.6
                }
            }
            $patternJson = $patternArgs | ConvertTo-Json -Compress -Depth 5
            $patternResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "pattern-recognition" -ArgumentsJson $patternJson

            if ($patternResult) {
                $patternData = $patternResult | ConvertFrom-Json
                if ($patternData -and $patternData.content) {
                    Write-Log "Patterns detected: $($patternData.content[0].text)" "DEBUG"
                    return $patternData.content[0].text
                }
            }
        } catch {
            Write-Log "Pattern recognition failed: $($_.Exception.Message)" "DEBUG"
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "PatternRecognition handler failed"
        return $null
    }
}

function Handle-PredictiveAnalytics {
    # PHASE 4: Predictive analytics for context selection
    # Uses: predictive-analytics to predict relevant context
    param(
        [string]$Context,
        [string]$UserIntent
    )

    try {
        Write-Log "Running predictive analytics for context selection" "DEBUG"

        # Predict relevant context parts
        try {
            $predictArgs = @{
                operation = "predict"
                query = $UserIntent
                data = @{
                    context = $Context
                    horizon = 100
                }
            }
            $predictJson = $predictArgs | ConvertTo-Json -Compress -Depth 5
            $predictResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive-analytics" -ArgumentsJson $predictJson

            if ($predictResult) {
                $predictData = $predictResult | ConvertFrom-Json
                if ($predictData -and $predictData.content) {
                    Write-Log "Predicted relevant context segments" "DEBUG"
                    return $predictData.content[0].text
                }
            }
        } catch {
            Write-Log "Predictive analytics failed: $($_.Exception.Message)" "DEBUG"
        }

        return $Context

    } catch {
        Handle-Error -Exception $_.Exception -Message "PredictiveAnalytics handler failed"
        return $Context
    }
}

function Handle-IntelligentAssistant {
    # PHASE 4: Intelligent assistant orchestration
    # Uses: intelligent-assistant for optimization decisions
    param(
        [string]$Query,
        [hashtable]$Data
    )

    try {
        Write-Log "Consulting intelligent assistant" "DEBUG"

        $assistantArgs = @{
            operation = "ask"
            query = $Query
            data = $Data
        }
        $assistantJson = $assistantArgs | ConvertTo-Json -Compress -Depth 5
        $assistantResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "intelligent-assistant" -ArgumentsJson $assistantJson

        if ($assistantResult) {
            $assistantData = $assistantResult | ConvertFrom-Json
            if ($assistantData -and $assistantData.content) {
                return $assistantData.content[0].text
            }
        }

        return $null

    } catch {
        Handle-Error -Exception $_.Exception -Message "IntelligentAssistant handler failed"
        return $null
    }
}

function Handle-PreToolUseOptimization {
    param([string]$InputJson)
    # PHASE 3: PreToolUse - Check cache, optimize inputs, avoid redundant calls
    # Uses: get_cached, predictive_cache, optimize_text for inputs
    try {
        if (-not $InputJson) {
            Write-Log "No input received for PreToolUse optimization" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $toolName = if ($data.tool_name) { $data.tool_name } else { "unknown" }
        $toolArgs = if ($data.tool_arguments) { $data.tool_arguments } else { @{} }

        Write-Log "PreToolUse optimization for: $toolName" "DEBUG"

        # Step 1: Check predictive cache for this tool call
        try {
            # PHASE 2 FIX: Use deterministic cache key instead of non-deterministic JSON
            $cacheKey = Get-DeterministicCacheKey -ToolName $toolName -ToolArgs $toolArgs
            $getCachedArgs = @{
                key = $cacheKey
            }
            $getCachedJson = $getCachedArgs | ConvertTo-Json -Compress
            $cachedResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "get_cached" -ArgumentsJson $getCachedJson

            if ($cachedResult) {
                $cachedData = $cachedResult | ConvertFrom-Json
                if ($cachedData -and $cachedData.content) {
                    Write-Log "Cache HIT for $toolName - avoiding redundant tool call" "INFO"

                    # PHASE 4 FIX: Track cache hit and persist immediately
                    if ($script:CurrentSession) {
                        $script:CurrentSession.cacheHits++
                        # CRITICAL: Persist immediately to disk for multi-process visibility
                        if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
                            Write-Log "Session stats updated and persisted after cache hit." "DEBUG"
                        } else {
                            Write-Log "Failed to persist session stats after cache hit." "ERROR"
                        }
                    }

                    # Return standard block response so dispatcher can exit 2
                    $blockResponse = @{
                        continue = $false
                        stopReason = "cache hit"
                        hookSpecificOutput = @{
                            hookEventName = "PreToolUse"
                            cached = $true
                            toolName = $toolName
                            cachedOutput = $cachedData.content[0].text
                        }
                    } | ConvertTo-Json -Depth 10 -Compress
                    Write-Output $blockResponse
                    [Console]::Out.Flush(); [Console]::Error.Flush()
                    return 2
                }
            }

            # PHASE 4 FIX: Track cache miss and persist immediately
            if ($script:CurrentSession) {
                $script:CurrentSession.cacheMisses++
                # CRITICAL: Persist immediately to disk for multi-process visibility
                if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
                    Write-Log "Session stats updated and persisted after cache miss." "DEBUG"
                } else {
                    Write-Log "Failed to persist session stats after cache miss." "ERROR"
                }
            }
        } catch {
            # Cache miss is normal, continue
            # PHASE 4 FIX: Track cache miss and persist immediately
            if ($script:CurrentSession) {
                $script:CurrentSession.cacheMisses++
                # CRITICAL: Persist immediately to disk for multi-process visibility
                if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
                    Write-Log "Session stats updated and persisted after cache miss (exception path)." "DEBUG"
                } else {
                    Write-Log "Failed to persist session stats after cache miss (exception path)." "ERROR"
                }
            }
            Write-Log "Cache miss for $toolName" "DEBUG"
        }

        # Step 2: Use predictive cache to predict if this call will be needed
        try {
            $predictArgs = @{
                operation = "predict"
                modelType = "hybrid"
                maxPredictions = 1
                confidence = 0.8
            }
            $predictJson = $predictArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive_cache" -ArgumentsJson $predictJson
        } catch {
            # Optional feature
        }

        # Step 3: Optimize tool input arguments if they contain large text (PHASE 4: Skip < 500 chars)
        $argsJson = $toolArgs | ConvertTo-Json -Depth 10
        if ($toolArgs -and $argsJson.Length -gt 500) {
            try {
                # PHASE 2 FIX: Use content hash instead of timestamp for cache key
                $hasher = [System.Security.Cryptography.SHA256]::Create()
                $hashBytes = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($argsJson))
                $contentHash = [Convert]::ToBase64String($hashBytes).Substring(0, 16)

                $optimizeArgs = @{
                    text = $argsJson
                    key = "tool_input_${toolName}_$contentHash"
                    quality = $script:OPTIMIZATION_QUALITY
                }
                $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
                $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson

                if ($optimizeResult) {
                    $optimizeData = $optimizeResult | ConvertFrom-Json
                    if ($optimizeData -and $optimizeData.content) {
                        Write-Log "Optimized input for $toolName" "DEBUG"
                    }
                }
            } catch {
                Write-Log "Input optimization failed: $($_.Exception.Message)" "WARN"
            }
        }

        # Record tool access for predictive caching
        try {
            $recordArgs = @{
                operation = "record-access"
                key = $cacheKey
                timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            }
            $recordJson = $recordArgs | ConvertTo-Json -Compress
            & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "predictive_cache" -ArgumentsJson $recordJson
        } catch {
            # Optional feature
        }

    } catch {
        Handle-Error -Exception $_.Exception -Message "PreToolUse optimization failed"
        return 1
    }
    return 0
}

function Handle-OptimizeToolOutput {
    param([string]$InputJson)
    # PHASE 1: PostToolUse optimization - optimize ALL tool outputs
    # Uses: optimize_text, count_tokens, compress_text, smart_cache

    # Temporarily set ErrorActionPreference to Stop for debugging
    $OriginalErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Stop'

    try {
        Write-Log "[Handle-OptimizeToolOutput] Entered function." "DEBUG"

        if (-not $InputJson) {
            Write-Log "No input received for tool output optimization" "WARN"
            Write-Log "[Handle-OptimizeToolOutput] No input received, returning." "DEBUG"
            return
        }

        Write-Log "[Handle-OptimizeToolOutput] Parsing InputJson..." "DEBUG"
        $data = $InputJson | ConvertFrom-Json
        $toolName = $data.tool_name
        $toolOutput = $data.tool_response  # FIXED: Claude Code uses tool_response not tool_result

        $outputType = if ($toolOutput) { $toolOutput.GetType().Name } else { "null" }
        Write-Log "DEBUG: tool_name=$toolName, tool_response_type=$outputType, has_content=$(-not -not $toolOutput)" "DEBUG"
        Write-Log "[Handle-OptimizeToolOutput] Checkpoint 1 - After line 1564 log. toolName=$toolName, outputType=$outputType" "DEBUG"

        # Skip if no output or if output is already optimized
        Write-Log "DEBUG: Checking if toolOutput is null or empty" "DEBUG"
        Write-Log "[Handle-OptimizeToolOutput] Checkpoint 2 - Before null/empty check." "DEBUG"
        if (-not $toolOutput) {
            Write-Log "No tool output to optimize for: $toolName (toolOutput is null/false)" "DEBUG"
            Write-Log "[Handle-OptimizeToolOutput] toolOutput is null/false, returning." "DEBUG"
            return
        }
        Write-Log "[Handle-OptimizeToolOutput] Checkpoint 3 - After null/empty check, toolOutput exists." "DEBUG"

        # Convert output to string for token counting
        $outputText = ""
        try {
            Write-Log "[Handle-OptimizeToolOutput] Checkpoint 4 - Attempting to convert toolOutput to string. Is string: $($toolOutput -is [string])" "DEBUG"
            $outputText = if ($toolOutput -is [string]) { $toolOutput } else { $toolOutput | ConvertTo-Json -Depth 10 -ErrorAction Stop }
            Write-Log "DEBUG: Converted tool output to string. Length: $($outputText.Length)" "DEBUG"
            Write-Log "[Handle-OptimizeToolOutput] Checkpoint 5 - toolOutput converted. Length: $($outputText.Length)" "DEBUG"
        } catch {
            Write-Log "ERROR: Failed to convert tool output to JSON string for ${toolName}: $($_.Exception.Message)" "ERROR"
            Write-Log "[Handle-OptimizeToolOutput] Failed to convert: $($_.Exception.Message)" "ERROR"
            return
        }

        # Count tokens BEFORE optimization
        $beforeTokens = 0
        try {
            Write-Log "DEBUG: Starting token counting for $toolName" "DEBUG"
            $countArgs = @{ text = $outputText }
            $countJson = $countArgs | ConvertTo-Json -Compress -ErrorAction Stop
            Write-Log "DEBUG: Calling invoke-mcp.ps1 count_tokens" "DEBUG"
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            Write-Log "DEBUG: invoke-mcp.ps1 returned, parsing result" "DEBUG"
            $countData = if ($countResult) { $countResult | ConvertFrom-Json -ErrorAction Stop } else { $null }
            if ($countData -and $countData.content) {
                $beforeTokens = [int]($countData.content[0].text)
                Write-Log "DEBUG: Successfully counted $beforeTokens tokens" "DEBUG"
            } else {
                Write-Log "WARN: count_tokens result did not contain expected content" "WARN"
            }
        } catch {
            Handle-Error -Exception $_.Exception -Message "Token counting failed for ${toolName}"
            return
        }

        Write-Log "Tool output before optimization: $beforeTokens tokens" "DEBUG"

        # PHASE 4: Skip optimization for small outputs < 500 characters
        if ($outputText.Length -lt 500) {
            Write-Log "Skipping optimization for small output ($($outputText.Length) chars)" "DEBUG"
            return
        }

        # PHASE 7: Apply tool-specific optimization first
        try {
            $specificOptimized = Handle-ToolSpecificOptimization -ToolName $toolName -ToolOutput $outputText
            if ($specificOptimized -and $specificOptimized.Length -lt $outputText.Length) {
                $outputText = $specificOptimized
                Write-Log "Tool-specific optimization applied for $toolName" "DEBUG"
            }
        } catch {
            Write-Log "Tool-specific optimization failed: $($_.Exception.Message)" "WARN"
        }

        # Calculate SHA256 hash of the output text for caching
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        $hashBytes = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($outputText))
        $originalTextHash = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToLower()

        # Attempt to retrieve from optimization storage
        try {
            $retrieveArgs = @{
                operation = "retrieve"
                originalTextHash = $originalTextHash
            }
            $retrieveJson = $retrieveArgs | ConvertTo-Json -Compress
            $retrieveResultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimization_storage" -ArgumentsJson $retrieveJson
            $retrieveResult = if ($retrieveResultJson) { $retrieveResultJson | ConvertFrom-Json } else { $null }

            if ($retrieveResult -and $retrieveResult.success -and $retrieveResult.result) {
                Write-Log "Cache HIT for optimization result. Hash: $originalTextHash" "INFO"
                # OptimizationStorageTool.retrieve() returns { success, result: { optimizedText, ... } }.
                # Read the actual payload from $retrieveResult.result (not top-level), and mirror
                # the base64 wrapping used on the store path below so round-tripped bytes survive JSON.
                $cachedEntry = $retrieveResult.result
                $optimizedTextBytes = [System.Convert]::FromBase64String($cachedEntry.optimizedText)
                $optimizedText = [System.Text.Encoding]::UTF8.GetString($optimizedTextBytes)
                $afterTokens = $cachedEntry.optimizedTokens
                $saved = $cachedEntry.tokensSaved
                $percent = if ($beforeTokens -gt 0) { [math]::Round(($saved / $beforeTokens) * 100, 1) } else { 0 }

                if ($script:CurrentSession) {
                    $script:CurrentSession.cacheHits++
                    if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
                        Write-Log "Session stats updated and persisted after cache hit." "DEBUG"
                    } else {
                        Write-Log "Failed to persist session stats after cache hit." "ERROR"
                    }
                }

                Write-Log "Using cached optimized $toolName output: $beforeTokens → $afterTokens tokens ($percent% reduction)" "INFO"
                Update-SessionOperation -TokensDelta $afterTokens
                return
            } else {
                Write-Log "Cache MISS for optimization result. Hash: $originalTextHash" "DEBUG"
            }
        } catch {
            Handle-Error -Exception $_.Exception -Message "Failed to retrieve from optimization storage"
        }

        # Optimize using optimize_text (PHASE 4: Reduced quality for performance)
        try {
            $optimizeArgs = @{
                text = $outputText
                quality = $script:OPTIMIZATION_QUALITY
            }
            $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
            $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson
            $optimizeData = if ($optimizeResult) { $optimizeResult | ConvertFrom-Json } else { $null }

            if ($optimizeData -and $optimizeData.content) {
                $optimizedText = $optimizeData.content[0].text
                $afterTokens = if ($optimizeData.metadata -and $optimizeData.metadata.compressedTokens) {
                    $optimizeData.metadata.compressedTokens
                } else { $beforeTokens }
                $saved = $beforeTokens - $afterTokens
                $percent = if ($beforeTokens -gt 0) { [math]::Round(($saved / $beforeTokens) * 100, 1) } else { 0 }

                if ($afterTokens -ge $beforeTokens) {
                    Write-Log "Optimization made things worse or had no effect ($beforeTokens → $afterTokens tokens), REVERTING to original" "WARN"
                    if ($script:CurrentSession) {
                        $script:CurrentSession.optimizationFailures++
                        if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
                            Write-Log "Session stats updated and persisted after optimization failure." "DEBUG"
                        } else {
                            Write-Log "Failed to persist session stats after optimization failure." "ERROR"
                        }
                    }
                    return
                }

                Write-Log "Optimized $toolName output: $beforeTokens → $afterTokens tokens ($percent% reduction)" "INFO"

                # Store the new optimization result
                try {
                    $storeArgs = @{
                        operation = "store"
                        originalTextHash = $originalTextHash
                        optimizedText = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($optimizedText))
                        originalTokens = $beforeTokens
                        optimizedTokens = $afterTokens
                        tokensSaved = $saved
                    }
                    $storeJson = $storeArgs | ConvertTo-Json -Compress
                    & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimization_storage" -ArgumentsJson $storeJson
                    Write-Log "Stored new optimization result. Hash: $originalTextHash" "DEBUG"
                } catch {
                    Handle-Error -Exception $_.Exception -Message "Failed to store optimization result"
                }

                if ($script:CurrentSession) {
                    $script:CurrentSession.optimizationSuccesses++
                    $script:CurrentSession.totalOriginalTokens += $beforeTokens
                    $script:CurrentSession.totalOptimizedTokens += $afterTokens
                    $script:CurrentSession.totalTokensSaved += $saved
                    if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
                        Write-Log "Session stats updated and persisted after optimization success." "DEBUG"
                    } else {
                        Write-Log "Failed to persist session stats after optimization success." "ERROR"
                    }
                }

                Update-SessionOperation -TokensDelta $afterTokens
            }
        } catch {
            Handle-Error -Exception $_.Exception -Message "Tool output optimization failed"
        }

    } catch {
        Write-Log "ERROR: OptimizeToolOutput handler failed: $($_.Exception.Message)" "ERROR"
        Write-Host "ERROR: [Handle-OptimizeToolOutput] Caught outer error: $($_.Exception.Message)"
        Write-Host "ERROR: [Handle-OptimizeToolOutput] Outer Stack Trace: $($_.ScriptStackTrace)"
    } finally {
        # Reset ErrorActionPreference to its original value
        $ErrorActionPreference = $OriginalErrorActionPreference
        Write-Host "DEBUG: [Handle-OptimizeToolOutput] Exiting function."
    }
}

function Handle-PreCompactOptimization {
    param([string]$InputJson)
    # PHASE 1: PreCompact aggressive context reduction
    # Uses: optimize_text, compress_text, count_tokens, smart_summarization
    try {
        if (-not $InputJson) {
            Write-Log "No input received for PreCompact optimization" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $contextText = if ($data.context) { $data.context } else { "" }

        if (-not $contextText) {
            Write-Log "No context to optimize in PreCompact" "DEBUG"
            return
        }

        Write-Log "Starting PreCompact aggressive optimization" "INFO"

        # Step 1: Count tokens BEFORE
        $beforeTokens = 0
        try {
            $countArgs = @{ text = $contextText }
            $countJson = $countArgs | ConvertTo-Json -Compress
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            $countData = if ($countResult) { $countResult | ConvertFrom-Json } else { $null }
            if ($countData -and $countData.content) {
                $beforeTokens = [int]($countData.content[0].text)
            }
        } catch {
            Write-Log "PreCompact token counting failed: $($_.Exception.Message)" "WARN"
        }

        Write-Log "Context before PreCompact: $beforeTokens tokens" "INFO"

        # PHASE 4: Apply intelligent summarization for large contexts
        if ($beforeTokens -gt 5000) {
            try {
                $summarized = Handle-IntelligentSummarization -Text $contextText -Context "precompact"
                if ($summarized -and $summarized.Length -lt $contextText.Length) {
                    $contextText = $summarized
                    Write-Log "After intelligent summarization: reduced from $($contextText.Length) chars" "INFO"
                }
            } catch {
                Write-Log "Intelligent summarization failed: $($_.Exception.Message)" "WARN"
            }
        }

        # PHASE 4: Pattern recognition to abstract recurring data
        try {
            $patterns = Handle-PatternRecognition -Text $contextText
            if ($patterns) {
                Write-Log "Patterns identified for abstraction" "DEBUG"
            }
        } catch {
            # Optional feature
        }

        # Step 2: Apply optimize_text (aggressive mode, PHASE 4: Reduced quality)
        $optimizedContext = $contextText
        try {
            # PHASE 2 FIX: Use content hash instead of timestamp for cache key
            $hasher = [System.Security.Cryptography.SHA256]::Create()
            $hashBytes = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($contextText))
            $contentHash = [Convert]::ToBase64String($hashBytes).Substring(0, 16)

            $optimizeArgs = @{
                text = $contextText
                key = "precompact_context_$contentHash"
                quality = $script:OPTIMIZATION_QUALITY
            }
            $optimizeJson = $optimizeArgs | ConvertTo-Json -Compress
            $optimizeResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "optimize_text" -ArgumentsJson $optimizeJson
            $optimizeData = if ($optimizeResult) { $optimizeResult | ConvertFrom-Json } else { $null }

            if ($optimizeData -and $optimizeData.content) {
                $optimizedContext = $optimizeData.content[0].text
                Write-Log "After optimize_text: $($optimizeData.metadata.compressedTokens) tokens" "DEBUG"
            }
        } catch {
            Write-Log "PreCompact optimize_text failed: $($_.Exception.Message)" "ERROR"
        }

        # Step 3: compress_text REMOVED - it bypassed safety checks and caused token expansion
        # The direct compress_text call was causing negative savings by:
        # 1. No check if compression actually helps (unlike optimize_text)
        # 2. Base64 encoding overhead (33-37%) often exceeded compression savings
        # 3. Resulted in 1.02x expansion instead of compression
        # Now relying solely on optimize_text which has proper safety checks

        # Step 4: Count tokens AFTER
        $afterTokens = 0
        try {
            $countArgs = @{ text = $optimizedContext }
            $countJson = $countArgs | ConvertTo-Json -Compress
            $countResult = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "count_tokens" -ArgumentsJson $countJson
            $countData = if ($countResult) { $countResult | ConvertFrom-Json } else { $null }
            if ($countData -and $countData.content) {
                $afterTokens = [int]($countData.content[0].text)
            }
        } catch {
            Write-Log "PreCompact final token counting failed: $($_.Exception.Message)" "WARN"
        }

        $saved = $beforeTokens - $afterTokens
        $percent = if ($beforeTokens -gt 0) { [math]::Round(($saved / $beforeTokens) * 100, 1) } else { 0 }

        Write-Log "PreCompact optimization complete: $beforeTokens → $afterTokens tokens ($percent% reduction, saved $saved tokens)" "INFO"

        # Output optimized context (if hooks support returning modified context)
        $result = @{
            optimizedContext = $optimizedContext
            beforeTokens = $beforeTokens
            afterTokens = $afterTokens
            tokensSaved = $saved
            reductionPercent = $percent
        } | ConvertTo-Json -Depth 10 -Compress

        Write-Output $result

    } catch {
        Write-Log "PreCompact optimization handler failed: $($_.Exception.Message)" "ERROR"
    }
}

function Handle-SmartRead {
    param([string]$InputJson)
    # Use smart_read MCP tool for intelligent file reading with built-in caching
    # This replaces plain Read with cache-aware, diff-based, truncated reading
    try {
        if (-not $InputJson) {
            Write-Log "No input received for smart-read" "WARN"
            return
        }

        $data = $InputJson | ConvertFrom-Json
        $toolName = $data.tool_name

        # Intercept ONLY the MCP filesystem read tools. Output substitution is
        # not possible for the built-in Read tool (updatedToolOutput is ignored
        # for built-in tools — anthropics/claude-code#32105); only MCP tools
        # support updatedMCPToolOutput. Built-in Read is steered to smart_read
        # via the opt-in PreToolUse redirect in the dispatcher instead.
        if ($toolName -notin @("mcp__filesystem__read_file", "mcp__filesystem__read_text_file")) {
            return
        }

        # Extract file path (different field names for different tools)
        $filePath = $data.tool_input.file_path
        if (-not $filePath) {
            $filePath = $data.tool_input.path
        }
        if (-not $filePath) {
            Write-Log "No file path in Read operation" "WARN"
            return
        }

        Write-Log "Calling smart_read for: $filePath" "DEBUG"

        # Call smart_read MCP tool with caching enabled
        $mcpArgs = @{
            path = $filePath
            enableCache = $true
            diffMode = $true
            maxSize = 100000
            includeMetadata = $true
        }
        $argsJson = $mcpArgs | ConvertTo-Json -Compress
        # This runs on every intercepted read, so it must be fast: daemon-only
        # (no slow npx fallback) with a short connect timeout. A missing daemon
        # then fails fast and we simply leave the original result untouched.
        $resultJson = & "$HELPERS_DIR\invoke-mcp.ps1" -Tool "smart_read" -ArgumentsJson $argsJson -DaemonOnly -ConnectTimeoutMs 1500
        $result = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }

        # Check for errors - if MCP call failed, allow fallback to plain Read
        if ($result -and $result.isError) {
            Write-Log "smart_read returned error: $($result.content[0].text)" "WARN"
            return
        }

        if ($result -and $result.content) {
            # SUCCESS - Block plain Read and return smart_read result
            # PHASE 1 FIX: Add debug logging and null-safe metadata parsing
            Write-Log "smart_read raw result: $($resultJson | Out-String)" "DEBUG"

            $fromCache = if ($result.metadata -and $result.metadata.fromCache) { "CACHE HIT" } else { "NEW READ" }
            $isDiff = if ($result.metadata -and $result.metadata.isDiff) { "DIFF" } else { "FULL" }
            $tokens = if ($result.metadata -and $result.metadata.tokenCount) { $result.metadata.tokenCount } else { "unknown" }
            $tokensSaved = if ($result.metadata -and $result.metadata.tokensSaved) { $result.metadata.tokensSaved } else { 0 }

            Write-Log "$fromCache - ${isDiff}: $filePath ($tokens tokens, saved $tokensSaved)" "INFO"

            # FIX: Update session tokens with the tokens from smart_read.
            # Discard the returned session object ($null = ...) so it does not
            # leak into this function's pipeline output — the caller captures
            # our return value ($code = Handle-SmartRead ...) to read the exit
            # signal, and a stray object there would corrupt that check.
            if ($tokens -ne "unknown") {
                $null = Update-SessionOperation -TokensDelta $tokens
                Write-Log "Updated session totalTokens by $tokens" "DEBUG"
            }

            # #122: update the MCP server's context_delta so the next read
            # of this file can be served as a diff. Failure here is
            # non-fatal — smart_read still succeeds.
            #
            # IMPORTANT: only feed FULL content. smart_read can return a
            # diff payload (metadata.isDiff), and persisting a diff as the
            # new baseline would make the next compute-delta compare
            # against the previous patch instead of the file contents.
            try {
                $isDiff = $result.metadata -and $result.metadata.isDiff
                $contentText = if ($result.content -and $result.content[0] -and $result.content[0].text) {
                    $result.content[0].text
                } else {
                    $null
                }
                if ($contentText -and -not $isDiff) {
                    $null = Invoke-ContextDelta -Operation 'compute-delta' -FilePath $filePath -CurrentContent $contentText
                }
            } catch {
                Write-Log "context_delta update skipped: $($_.Exception.Message)" 'DEBUG'
            }

            # Substitute the MCP read tool's result with smart_read's optimized
            # content using `updatedMCPToolOutput` (the ONLY output-substitution
            # contract Claude Code supports, and only for MCP tools — see
            # anthropics/claude-code#32105). The replacement must MATCH the MCP
            # tool's output schema, i.e. a CallToolResult { content: [...] }, so
            # we hand back smart_read's content array (cached/diffed/truncated).
            if (-not $result.content) {
                Write-Log "smart_read produced empty content for $filePath - leaving original result" "WARN"
                return 0
            }

            $substituteResponse = @{
                hookSpecificOutput = @{
                    hookEventName = "PostToolUse"
                    # Replaces the MCP tool result returned to Claude. Shape must
                    # match the tool's output (a CallToolResult content array).
                    updatedMCPToolOutput = @{
                        content = $result.content
                    }
                }
            } | ConvertTo-Json -Depth 10 -Compress

            # #6: write straight to the console stream, NOT Write-Output. When
            # the dispatch site captures this function's value
            # (`$code = Handle-SmartRead ...`), Write-Output would be swallowed
            # into that variable and never reach stdout. [Console]::Out bypasses
            # the pipeline so the JSON is emitted regardless of how we're called.
            [Console]::Out.Write($substituteResponse)
            [Console]::Out.Flush()
            [Console]::Error.Flush()
            return 2  # Signal to the caller: a replacement result was emitted.

        } else {
            # FAILED - Allow plain Read to proceed
            Write-Log "smart_read failed for $filePath - falling back to plain Read" "WARN"
            return 0
        }

    } catch {
        Write-Log "smart_read failed: $($_.Exception.Message)" "ERROR"
        # On error, allow plain Read to proceed
        return 0
    }
}

# Cleanup function to flush logs on exit
function Cleanup-Session {
    try {
        # Flush any remaining logs
        Flush-OperationLogs -Force

        # Persist final session state from in-memory $script:CurrentSession to file
        if ($script:CurrentSession) {
            if (Write-SessionFile -FilePath $SESSION_FILE -SessionObject $script:CurrentSession) {
                Write-Log "Final session state persisted: $($script:CurrentSession.totalOperations) ops, $($script:CurrentSession.totalTokens) tokens" "INFO"
            } else {
                Write-Log "Failed to persist final session state to file during cleanup." "ERROR"
            }
        }

        # Stop timer
        if ($script:FlushTimer) {
            $script:FlushTimer.Stop()
            $script:FlushTimer.Dispose()
            $script:FlushTimer = $null # Clear timer to allow re-initialization in next process
        }
    } catch {
        Write-Log "Cleanup-Session failed: $($_.Exception.Message)" "ERROR"
    }
}

# Main execution - Only run if script is executed directly (not dot-sourced)
# When dot-sourced by dispatcher.ps1, this block is skipped and only functions are loaded
if ($MyInvocation.InvocationName -ne '.') {
    # Initialize session at the very start of the script execution.
    # This loads the latest state from file into $script:CurrentSession.
    # Discard the returned session object ($null = ...) — otherwise it is
    # emitted to stdout and would corrupt the JSON we relay for the
    # PostToolUse smart-read `updatedToolOutput` substitution.
    $null = Initialize-Session

    try {
        Write-Log "Phase: $Phase, Action: $Action" "INFO"

        switch ($Action) {
            "smart-read" {
                # #5: capture the return and convert it into a REAL process exit
                # code. The old code did `return 2` from the function but the
                # switch always fell through to `exit 0`, so the dispatcher's
                # `$LASTEXITCODE -eq 2` check never fired and substitution never
                # engaged. Now exit 2 propagates to the dispatcher as the signal
                # that a replacement tool result was written to stdout.
                $smartReadCode = Handle-SmartRead -InputJson $InputJson
                if ($smartReadCode -eq 2) {
                    [Console]::Out.Flush()
                    exit 2
                }
            }
            "context-guard" {
                # Same #5-class fix as smart-read: convert the function's
                # return 2 into a real exit code so the dispatcher's
                # `$LASTEXITCODE -eq 2` check fires and the token-budget block
                # actually engages (previously it never did).
                $guardCode = Handle-ContextGuard -InputJson $InputJson
                if (($guardCode | Select-Object -Last 1) -eq 2) {
                    exit 2
                }
            }
            "periodic-optimize" {
                Handle-PeriodicOptimize -InputJson $InputJson
            }
            "cache-warmup" {
                Handle-CacheWarmup -InputJson $InputJson
            }
            "session-report" {
                Handle-SessionReport -InputJson $InputJson
                # Cleanup-Session is now in finally block, no need here
            }
            "log-operation" {
                Handle-LogOperation -InputJson $InputJson
            }
            "optimize-session" {
                Handle-OptimizeSession -InputJson $InputJson
                # Cleanup-Session is now in finally block, no need here
            }
            "session-track" {
                # Update operation count and persist immediately for session-track
                # This ensures the counter is updated even if the process exits quickly
                $session = Update-SessionOperation
                Write-Log "Operation #$($session.totalOperations)" "DEBUG"
            }
            "optimize-tool-output" {
                Write-Log "DIAGNOSTIC: optimize-tool-output action triggered (script version $SCRIPT_VERSION)" "INFO"
                Handle-OptimizeToolOutput -InputJson $InputJson

                # Cleanup temp file after background optimization completes
                if ($InputJsonFile -and (Test-Path $InputJsonFile)) {
                    try {
                        Remove-Item -Path $InputJsonFile -Force -ErrorAction Stop
                        Write-Log "BACKGROUND: Cleaned up temp file after optimization: $InputJsonFile" "DEBUG"
                    } catch {
                        Write-Log "BACKGROUND: Failed to cleanup temp file ${InputJsonFile}: $($_.Exception.Message)" "WARN"
                    }
                }
            }
            "precompact-optimize" {
                Handle-PreCompactOptimization -InputJson $InputJson
            }
            "user-prompt-optimize" {
                Handle-UserPromptOptimization -InputJson $InputJson
            }
            "session-start-init" {
                Handle-SessionStartInit -InputJson $InputJson
            }
            "pretooluse-optimize" {
                Handle-PreToolUseOptimization -InputJson $InputJson
            }
            Default {
                Write-Log "Unknown action: $Action" "WARN"
            }
        }

        exit 0

    } catch {
        Write-Log "Orchestrator failed: $($_.Exception.Message)" "ERROR"
        exit 0  # Never block on error
    } finally {
        # Ensure cleanup runs regardless of success or failure
        Cleanup-Session
    }
}
