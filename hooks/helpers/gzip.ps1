[CmdletBinding()]
param()

<#
Gzip utilities — addresses issue #126 (PowerShell side).

Compress-String / Expand-String are the primitives. Save-GzippedFile
writes <path>.gz atomically (tmp + rename) and strips the plaintext
sibling once the gzip lands. Read-MaybeGzippedFile prefers <path>.gz
and falls back to plaintext so PS code can be migrated incrementally.
#>

function Compress-String {
    param(
        [Parameter(Mandatory = $true)][string]$InputString,
        [ValidateSet('Optimal', 'Fastest', 'NoCompression', 'SmallestSize')]
        [string]$CompressionLevel = 'Optimal'
    )
    $inputStream = $null
    $outputStream = $null
    $gzipStream = $null
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($InputString)
        $inputStream = [System.IO.MemoryStream]::new($bytes)
        $outputStream = [System.IO.MemoryStream]::new()
        $level = [System.IO.Compression.CompressionLevel]::$CompressionLevel
        $gzipStream = [System.IO.Compression.GZipStream]::new($outputStream, $level)
        $inputStream.CopyTo($gzipStream)
        $gzipStream.Dispose()
        $gzipStream = $null
        return ,$outputStream.ToArray()
    } finally {
        if ($null -ne $gzipStream) { $gzipStream.Dispose() }
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $outputStream) { $outputStream.Dispose() }
    }
}

function Expand-String {
    param(
        [Parameter(Mandatory = $true)][byte[]]$CompressedBytes
    )
    $inputStream = $null
    $outputStream = $null
    $gzipStream = $null
    try {
        $inputStream = [System.IO.MemoryStream]::new($CompressedBytes)
        $outputStream = [System.IO.MemoryStream]::new()
        $gzipStream = [System.IO.Compression.GZipStream]::new(
            $inputStream,
            [System.IO.Compression.CompressionMode]::Decompress
        )
        $gzipStream.CopyTo($outputStream)
        return [System.Text.Encoding]::UTF8.GetString($outputStream.ToArray())
    } finally {
        if ($null -ne $gzipStream) { $gzipStream.Dispose() }
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $outputStream) { $outputStream.Dispose() }
    }
}

function Save-GzippedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $compressed = Compress-String -InputString $Content
    $gzPath = "$Path.gz"
    # Per-write temp path so concurrent writers to the same destination
    # can't clobber each other mid-write.
    $tmpPath = "$gzPath.$([guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllBytes($tmpPath, $compressed)
    # Atomic swap: File::Move(src, dst, overwrite:$true) on .NET5+.
    # Unlike "delete then move", this never leaves the caller with a
    # missing .gz file if the process crashes.
    try {
        [System.IO.File]::Move($tmpPath, $gzPath, $true)
    } finally {
        if (Test-Path $tmpPath) {
            Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path $Path) {
        Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
    }
    return @{
        originalBytes = [System.Text.Encoding]::UTF8.GetByteCount($Content)
        compressedBytes = $compressed.Length
    }
}

function Read-MaybeGzippedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    $gzPath = "$Path.gz"
    if (Test-Path $gzPath) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($gzPath)
            return Expand-String -CompressedBytes $bytes
        } catch {
            # Corrupt / partial .gz — fall back to the plaintext sibling
            # so the backward-compat migration path still works. If no
            # plaintext exists either, rethrow the original error.
            if (-not (Test-Path $Path)) {
                throw
            }
        }
    }
    if (Test-Path $Path) {
        return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    }
    return $null
}
