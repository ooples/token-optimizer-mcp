$ErrorActionPreference = 'Stop'
$memorySource = @'
using System;
using System.Runtime.InteropServices;
public static class BenchmarkMemory {
  [StructLayout(LayoutKind.Sequential)]
  public struct Info {
    public uint Size;
    public UIntPtr CommitTotal, CommitLimit, CommitPeak;
    public UIntPtr PhysicalTotal, PhysicalAvailable, SystemCache;
    public UIntPtr KernelTotal, KernelPaged, KernelNonpaged, PageSize;
    public uint HandleCount, ProcessCount, ThreadCount;
  }
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetPerformanceInfo(ref Info info, uint size);
  public static Info Read() {
    var info = new Info();
    info.Size = (uint)Marshal.SizeOf(info);
    if (!GetPerformanceInfo(ref info, info.Size))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return info;
  }
}
'@
Add-Type -TypeDefinition $memorySource
while ($true) {
  $memoryInfo = [BenchmarkMemory]::Read()
  $pageBytes = $memoryInfo.PageSize.ToUInt64()
  [ordered]@{
    at = [DateTime]::UtcNow.ToString('o')
    committedBytes = $memoryInfo.CommitTotal.ToUInt64() * $pageBytes
    commitLimitBytes = $memoryInfo.CommitLimit.ToUInt64() * $pageBytes
    availablePhysicalBytes = $memoryInfo.PhysicalAvailable.ToUInt64() * $pageBytes
  } | ConvertTo-Json -Compress
  Start-Sleep -Milliseconds 1000
}
