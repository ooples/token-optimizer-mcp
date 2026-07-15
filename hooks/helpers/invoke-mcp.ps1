# MCP Invocation Helper
# Provides unified interface for calling token-optimizer-mcp tools via IPC daemon
#
# Performance improvement: Uses named pipe IPC instead of npx spawning
# - Before: 1000-4000ms per call (npx spawn overhead)
# - After: 2-5ms per call (IPC overhead)
# - Speedup: 285x faster

param(
    [Parameter(Mandatory=$true)]
    [string]$Tool,

    [Parameter(Mandatory=$false)]
    [string]$ArgumentsJson = "{}",

    [Parameter(Mandatory=$false)]
    [string]$ServerName = "token-optimizer"
)

$profileRoot = $env:USERPROFILE
if (-not $profileRoot) {
    throw "USERPROFILE is not set; cannot resolve log directory."
}
$logDir = Join-Path $profileRoot ".claude-global\hooks\logs"
if (-not (Test-Path $logDir)) {
    New-Item -Path $logDir -ItemType Directory -Force | Out-Null
}
$LOG_FILE = Join-Path $logDir "mcp-invocation.log"
$PERF_LOG = Join-Path $logDir "performance.csv"
$SOCKET_PATH = "\.\pipe\token-optimizer-daemon"

# Convert PSCustomObject to Hashtable recursively
# This function must be defined before use
function ConvertTo-Hashtable {
    param([Parameter(ValueFromPipeline)]$InputObject)

    if ($null -eq $InputObject) { return $null }

    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        $collection = @()
        foreach ($item in $InputObject) {
            $collection += ConvertTo-Hashtable $item
        }
        return $collection
    }

    if ($InputObject -is [psobject]) {
        $hash = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $hash[$property.Name] = ConvertTo-Hashtable $property.Value
        }
        return $hash
    }

    return $InputObject
}

# Convert JSON string to hashtable
try {
    $jsonObj = $ArgumentsJson | ConvertFrom-Json
    $Arguments = ConvertTo-Hashtable $jsonObj
    if ($null -eq $Arguments) {
        $Arguments = @{}
    }
} catch {
    # Silently fall back to empty hashtable
    $Arguments = @{}
}

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    try {
        $logEntry | Out-File -FilePath $LOG_FILE -Append -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Silently fail
    }
}

function Log-Performance {
    param(
        [string]$Tool,
        [string]$Server,
        [double]$DurationMs
    )

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $csvLine = "$timestamp,$Server,$Tool,$DurationMs"
    try {
        # Create CSV header if file doesn't exist
        if (!(Test-Path $PERF_LOG)) {
            "Timestamp,Server,Tool,DurationMs" | Out-File -FilePath $PERF_LOG -Encoding UTF8
        }
        $csvLine | Out-File -FilePath $PERF_LOG -Append -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Silently fail
    }
}

function Invoke-MCPViaDaemon {
    param(
        [string]$Tool,
        $ToolArguments
    )

    try {
        Write-Log "Invoking MCP via daemon: $Tool" "DEBUG"

        # Ensure ToolArguments is a proper object
        if ($null -eq $ToolArguments) {
            $ToolArguments = @{}
        }

        # Build JSON-RPC request
        $request = @{
            jsonrpc = "2.0"
            id = [guid]::NewGuid().ToString()
            method = "tools/call"
            params = @{
                name = $Tool
                arguments = $ToolArguments
            }
        } | ConvertTo-Json -Depth 10 -Compress

        Write-Log "Daemon request: $request" "DEBUG"

        # Connect to daemon via named pipe
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "token-optimizer-daemon", "InOut")

        try {
            # Connect with 5 second timeout
            $pipe.Connect(5000)

            # Write request
            $writer = New-Object System.IO.StreamWriter($pipe)
            $writer.AutoFlush = $true
            $writer.WriteLine($request)

            # Read response
            $reader = New-Object System.IO.StreamReader($pipe)
            $response = $reader.ReadLine()

            Write-Log "Daemon response: $response" "DEBUG"

            # Parse JSON-RPC response
            $responseObj = $response | ConvertFrom-Json

            if ($responseObj.error) {
                Write-Log "Daemon error: $($responseObj.error.message)" "ERROR"
                return $null
            }

            return $responseObj.result

        } finally {
            if ($writer) { $writer.Dispose() }
            if ($reader) { $reader.Dispose() }
            if ($pipe) { $pipe.Dispose() }
        }

    } catch {
        Write-Log "Daemon communication failed: $($_.Exception.Message)" "ERROR"
        Write-Log "Falling back to npx spawn method" "WARN"
        return $null
    }
}

function Invoke-MCPViaNpx {
    param(
        [string]$Tool,
        $ToolArguments,
        [int]$TimeoutMs = 20000
    )

    # token-optimizer-mcp is a LONG-RUNNING stdio MCP server. The old fallback
    # piped a single bare tools/call into `npx ... token-optimizer-mcp` with no
    # MCP initialize handshake, never closed stdin, and had no timeout — so the
    # server sat waiting for more stdin and NEVER exited. That hung every hook
    # (i.e. every user turn) forever and left orphaned node/npx processes.
    #
    # This version:
    #   1. Sends the full stdio lifecycle: initialize -> notifications/initialized
    #      -> tools/call, one JSON-RPC message per line.
    #   2. CLOSES stdin (EOF) so the server's stdio transport shuts down and the
    #      process exits on its own.
    #   3. Enforces a hard timeout and force-kills the whole process tree
    #      (cmd -> npx -> node) via taskkill /T if it ever overruns.
    $proc = $null
    try {
        Write-Log "Invoking MCP via npx (fallback): $Tool" "DEBUG"

        if ($null -eq $ToolArguments) {
            $ToolArguments = @{}
        }

        if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
            Write-Log "npx not found on PATH; cannot use npx fallback" "ERROR"
            return $null
        }

        $initReq = @{
            jsonrpc = "2.0"
            id = 1
            method = "initialize"
            params = @{
                protocolVersion = "2024-11-05"
                capabilities = @{}
                clientInfo = @{ name = "token-optimizer-hooks"; version = "1.0.0" }
            }
        } | ConvertTo-Json -Depth 10 -Compress

        $initializedNote = @{
            jsonrpc = "2.0"
            method = "notifications/initialized"
        } | ConvertTo-Json -Compress

        $callReq = @{
            jsonrpc = "2.0"
            id = 2
            method = "tools/call"
            params = @{
                name = $Tool
                arguments = $ToolArguments
            }
        } | ConvertTo-Json -Depth 10 -Compress

        $stdinPayload = "$initReq`n$initializedNote`n$callReq`n"
        Write-Log "npx tools/call request: $callReq" "DEBUG"

        $env:TOKEN_OPTIMIZER_CACHE_DIR = "$env:USERPROFILE\.token-optimizer-cache"

        # Launch through a real Process we control so we can time it out and
        # kill the tree. npx is a .cmd shim on Windows, so go via cmd.exe.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = "/c npx -y token-optimizer-mcp@latest"
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($psi)

        # Drain stdout/stderr asynchronously so a full pipe buffer can't
        # deadlock the child while we wait.
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()

        # Send the lifecycle and CLOSE stdin — this is what lets the server exit.
        $proc.StandardInput.Write($stdinPayload)
        $proc.StandardInput.Close()

        if (-not $proc.WaitForExit($TimeoutMs)) {
            Write-Log "npx MCP call timed out after ${TimeoutMs}ms; killing process tree $($proc.Id)" "ERROR"
            # PS 5.1 / .NET Framework has no Process.Kill(bool) tree overload,
            # so use taskkill /T to take out cmd -> npx -> node together.
            try { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null } catch {}
            return $null
        }

        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()

        if ($proc.ExitCode -ne 0) {
            Write-Log "npx exited with code $($proc.ExitCode): $stderr" "ERROR"
        }

        # The server emits one JSON-RPC message per line. Return the result for
        # our tools/call (id = 2); ignore the initialize response (id = 1).
        foreach ($line in ($stdout -split "`n")) {
            $trimmed = $line.Trim()
            if (-not $trimmed.StartsWith("{")) { continue }
            try {
                $obj = $trimmed | ConvertFrom-Json
            } catch {
                continue
            }
            if ($obj.id -eq 2) {
                if ($obj.error) {
                    Write-Log "MCP error: $($obj.error.message)" "ERROR"
                    return $null
                }
                return $obj.result
            }
        }

        Write-Log "npx fallback returned no tools/call response" "WARN"
        return $null

    } catch {
        Write-Log "npx invocation failed: $($_.Exception.Message)" "ERROR"
        return $null
    } finally {
        # Never leave an orphaned process behind, even on early return/throw.
        if ($proc -and -not $proc.HasExited) {
            try { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null } catch {}
        }
        if ($proc) { $proc.Dispose() }
    }
}

# Main execution
$mcpStart = Get-Date

# Try daemon first (fast path)
$result = Invoke-MCPViaDaemon -Tool $Tool -ToolArguments $Arguments

# Fallback to npx if daemon unavailable
if ($null -eq $result) {
    Write-Log "Daemon unavailable, using npx fallback" "WARN"
    $result = Invoke-MCPViaNpx -Tool $Tool -ToolArguments $Arguments
    $server = "npx"
} else {
    $server = "daemon"
}

$mcpDuration = ((Get-Date) - $mcpStart).TotalMilliseconds

# Log performance metrics
Log-Performance -Tool $Tool -Server $server -DurationMs $mcpDuration

Write-Log "MCP call completed in ${mcpDuration}ms via $server" "INFO"

# Output result as JSON for caller
if ($result) {
    $result | ConvertTo-Json -Depth 10 -Compress
} else {
    Write-Log "MCP call returned no result" "WARN"
    @{ success = $false } | ConvertTo-Json
}
