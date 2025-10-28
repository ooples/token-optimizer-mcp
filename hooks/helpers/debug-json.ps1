# Debug JSON issues

$args = @{text="Testing"}
$json = $args | ConvertTo-Json -Compress

Write-Host "JSON from ConvertTo-Json:"
Write-Host $json
Write-Host ""

# Write to temp file
$temp = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($temp, $json, [System.Text.UTF8Encoding]::new($false))

# Read it back
$read = Get-Content $temp -Raw

Write-Host "JSON read back:"
Write-Host $read
Write-Host ""

# Show hex dump of first few bytes
$bytes = [System.IO.File]::ReadAllBytes($temp)
Write-Host "First 20 bytes (hex):"
$bytes[0..19] | ForEach-Object { Write-Host ("{0:X2}" -f $_) -NoNewline; Write-Host " " -NoNewline }
Write-Host ""

# Clean up
Remove-Item $temp

# Try passing directly to node
Write-Host "Testing node parsing:"
node -e "try { console.log(JSON.parse(process.argv[1])); } catch(e) { console.error('Parse error:', e.message); }" $json
