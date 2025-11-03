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
    $logMessage | Out-File -FilePath $script:LOG_FILE -Append -Encoding UTF8
    Write-Verbose $logMessage
}

function Handle-Error {
    param(
        [System.Exception]$Exception,
        [string]$Message = ""
    )

    $errorMessage = if ($Message) { $Message } else { $Exception.Message }
    $stackTrace = $Exception.ScriptStackTrace
    Write-Log "ERROR: $errorMessage" "ERROR"
    Write-Log "StackTrace: $stackTrace" "ERROR"
}