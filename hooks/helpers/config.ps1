[CmdletBinding()]
param()

<#
Token-Optimizer Config helper — addresses issue #120 (PowerShell side).

Mirrors src/core/config.ts so the PS orchestrator and the TS server
share one source of truth. The config file lives at
~/.token-optimizer/config.json and is the same one the Node server
reads. On first run we copy the defaults below into that file.
#>

$script:TokenOptimizerConfigPath =
    Join-Path $env:USERPROFILE '.token-optimizer\config.json'

$script:TokenOptimizerDefaultConfig = @{
    cache = @{
        enabled = $true
        maxSizeMB = 500
        defaultTTL = 300
        ttlByType = @{
            file_read = 300
            git_status = 60
            git_diff = 120
            build_result = 600
            test_result = 300
        }
        compression = 'auto'
    }
    monitoring = @{
        enabled = $true
        detailedLogging = $false
        metricsRetentionDays = 30
        dashboardPort = 3100
        enableWebUI = $false
    }
    optimization = @{
        compressionTokenThreshold = 0.7
        compressionPreserveThreshold = 0.3
        minTokensBeforeCompression = 1000
        modelTokenLimits = @{
            'gpt-4' = 128000
            'gpt-4-turbo' = 128000
            'gpt-3.5-turbo' = 16385
            'claude-3-opus' = 200000
            'claude-3-sonnet' = 200000
            'claude-3-haiku' = 200000
            'claude-opus-4-7' = 1000000
            'claude-sonnet-4-6' = 1000000
            'gemini-1.5-pro' = 2000000
            'gemini-2.5-flash' = 1000000
        }
        minOutputSizeBytes = 500
        quality = 'balanced'
        cacheSettings = @{
            maxSize = 1000
            ttlSeconds = 3600
        }
        chatCompression = @{
            enabled = $true
            strategy = 'summarize'
        }
    }
}

function Get-TokenOptimizerConfigPath {
    return $script:TokenOptimizerConfigPath
}

function Write-TokenOptimizerDefaultConfig {
    $configPath = Get-TokenOptimizerConfigPath
    $configDir = Split-Path -Parent $configPath
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }
    $json = $script:TokenOptimizerDefaultConfig | ConvertTo-Json -Depth 10
    Set-Content -Path $configPath -Value $json -Encoding UTF8
}

function Import-TokenOptimizerConfig {
    $configPath = Get-TokenOptimizerConfigPath
    if (-not (Test-Path $configPath)) {
        Write-TokenOptimizerDefaultConfig
        return $script:TokenOptimizerDefaultConfig
    }
    try {
        $raw = Get-Content -Path $configPath -Raw -Encoding UTF8
        return ($raw | ConvertFrom-Json -AsHashtable)
    } catch {
        $msg = "Failed to load $configPath ($($_.Exception.Message)); using defaults."
        if (Get-Command Write-Log -ErrorAction SilentlyContinue) {
            Write-Log $msg 'WARN'
        } else {
            Write-Warning $msg
        }
        return $script:TokenOptimizerDefaultConfig
    }
}

function Merge-TokenOptimizerHashtable {
    param(
        [hashtable]$Base,
        $User
    )
    $merged = @{}
    foreach ($key in $Base.Keys) {
        $merged[$key] = $Base[$key]
    }
    if ($null -eq $User) {
        return $merged
    }
    # Handle both hashtables and PSCustomObjects (ConvertFrom-Json returns the latter).
    $userKeys = @()
    if ($User -is [hashtable]) {
        $userKeys = $User.Keys
    } elseif ($User.PSObject) {
        $userKeys = $User.PSObject.Properties.Name
    }
    foreach ($key in $userKeys) {
        $userValue = if ($User -is [hashtable]) { $User[$key] } else { $User.$key }
        if ($Base.ContainsKey($key) -and ($Base[$key] -is [hashtable]) -and ($null -ne $userValue)) {
            $merged[$key] = Merge-TokenOptimizerHashtable -Base $Base[$key] -User $userValue
        } else {
            $merged[$key] = $userValue
        }
    }
    return $merged
}

function Get-TokenOptimizerOptimizationConfig {
    $config = Import-TokenOptimizerConfig
    $defaults = $script:TokenOptimizerDefaultConfig.optimization
    if ($null -eq $config.optimization) {
        return $defaults
    }
    # Deep-merge the user's partial optimization section onto defaults so
    # overriding one modelTokenLimit doesn't drop the rest of the map.
    return Merge-TokenOptimizerHashtable -Base $defaults -User $config.optimization
}

function Get-TokenOptimizerModelTokenLimit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModelName
    )
    $opt = Get-TokenOptimizerOptimizationConfig
    if ($opt.modelTokenLimits -and $opt.modelTokenLimits.ContainsKey($ModelName)) {
        return $opt.modelTokenLimits[$ModelName]
    }
    return $null
}
