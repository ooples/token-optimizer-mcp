[CmdletBinding()]
param()

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('DEBUG','INFO','WARN','ERROR')][string]$Level = "INFO",
        [string]$Context = ""
    )

    # Check if debug logging is disabled
    $debugLogging = if ($env:TOKEN_OPTIMIZER_DEBUG_LOGGING) {
        $env:TOKEN_OPTIMIZER_DEBUG_LOGGING -eq 'true'
    } else {
        $true  # Default: enabled
    }

    if ($Level -eq 'DEBUG' -and -not $debugLogging) {
        return
    }

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $contextPart = if ($Context) { " [$Context]" } else { "" }
    $logMessage = "[$timestamp] [$Level]$contextPart $Message"
    if ($script:LOG_FILE) {
        try {
            $logDir = Split-Path -Parent $script:LOG_FILE
            if ($logDir -and -not (Test-Path $logDir)) {
                New-Item -ItemType Directory -Path $logDir -Force | Out-Null
            }
            $logMessage | Out-File -FilePath $script:LOG_FILE -Append -Encoding UTF8
        } catch {
            # Swallow — logging must never be a failure mode for the caller.
        }
    }
    Write-Verbose $logMessage
}

function Handle-Error {
    param(
        [System.Exception]$Exception,
        [string]$Message = ""
    )

    $errorMessage = if ($Message) { $Message } else { $Exception.Message }
    # $StackTrace is a built-in PowerShell automatic variable — use a
    # different name so we don't shadow it.
    $exceptionTrace = $Exception.ScriptStackTrace
    Write-Log "ERROR: $errorMessage" "ERROR"
    Write-Log "StackTrace: $exceptionTrace" "ERROR"
}