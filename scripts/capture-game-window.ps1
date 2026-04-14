param(
  [string]$WindowTitleKeyword,
  [int]$MinWidth,
  [int]$MinHeight
)

$ErrorActionPreference = "Stop"

if (-not $WindowTitleKeyword) {
  $WindowTitleKeyword = ([string][char]0x5929) + ([char]0x6daf) + ([char]0x660e) + ([char]0x6708) + ([char]0x5200) + ([char]0x624b) + ([char]0x6e38)
}

if (-not $MinWidth) {
  $MinWidth = 640
}

if (-not $MinHeight) {
  $MinHeight = 360
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WindowCaptureNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
'@

function Write-JsonResult {
  param(
    [hashtable]$Payload
  )

  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $Payload | ConvertTo-Json -Depth 6 -Compress
}

try {
  $matches = New-Object System.Collections.Generic.List[object]

  $callback = [WindowCaptureNative+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [WindowCaptureNative]::IsWindowVisible($hWnd)) {
      return $true
    }

    $builder = New-Object System.Text.StringBuilder 512
    [void][WindowCaptureNative]::GetWindowText($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString().Trim()

    if ([string]::IsNullOrWhiteSpace($title) -or $title -notlike "*$WindowTitleKeyword*") {
      return $true
    }

    $rect = New-Object WindowCaptureNative+RECT
    if (-not [WindowCaptureNative]::GetWindowRect($hWnd, [ref]$rect)) {
      return $true
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top

    $matches.Add([pscustomobject]@{
      Title = $title
      IsMinimized = [WindowCaptureNative]::IsIconic($hWnd)
      Left = $rect.Left
      Top = $rect.Top
      Width = $width
      Height = $height
      Area = $width * $height
      ExactTitleMatch = ($title -eq $WindowTitleKeyword)
    }) | Out-Null

    return $true
  }

  [void][WindowCaptureNative]::EnumWindows($callback, [IntPtr]::Zero)

  if ($matches.Count -eq 0) {
    Write-Output (Write-JsonResult @{
      ok = $false
      errorCode = "WINDOW_NOT_FOUND"
      message = "No visible window matched the requested title keyword."
    })
    exit 0
  }

  $selected = $matches |
    Sort-Object @{ Expression = { if ($_.ExactTitleMatch) { 1 } else { 0 } }; Descending = $true },
                @{ Expression = { $_.Area }; Descending = $true } |
    Select-Object -First 1

  if ($selected.IsMinimized) {
    Write-Output (Write-JsonResult @{
      ok = $false
      errorCode = "WINDOW_MINIMIZED"
      message = "The target window is minimized and cannot be captured."
      windowTitle = $selected.Title
    })
    exit 0
  }

  if ($selected.Width -lt $MinWidth -or $selected.Height -lt $MinHeight) {
    Write-Output (Write-JsonResult @{
      ok = $false
      errorCode = "INVALID_BOUNDS"
      message = "The target window is smaller than the minimum capture size."
      windowTitle = $selected.Title
      bounds = @{
        left = $selected.Left
        top = $selected.Top
        width = $selected.Width
        height = $selected.Height
      }
    })
    exit 0
  }

  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $left = [Math]::Max($selected.Left, $virtual.Left)
  $top = [Math]::Max($selected.Top, $virtual.Top)
  $right = [Math]::Min($selected.Left + $selected.Width, $virtual.Left + $virtual.Width)
  $bottom = [Math]::Min($selected.Top + $selected.Height, $virtual.Top + $virtual.Height)
  $clampedWidth = $right - $left
  $clampedHeight = $bottom - $top

  if ($clampedWidth -lt $MinWidth -or $clampedHeight -lt $MinHeight) {
    Write-Output (Write-JsonResult @{
      ok = $false
      errorCode = "INVALID_BOUNDS"
      message = "The visible area of the target window is too small to capture."
      windowTitle = $selected.Title
      bounds = @{
        left = $left
        top = $top
        width = $clampedWidth
        height = $clampedHeight
      }
    })
    exit 0
  }

  $bitmap = New-Object System.Drawing.Bitmap $clampedWidth, $clampedHeight
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($clampedWidth, $clampedHeight)))

  $memory = New-Object System.IO.MemoryStream
  $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()

  $base64 = [Convert]::ToBase64String($memory.ToArray())
  $memory.Dispose()

  Write-Output (Write-JsonResult @{
    ok = $true
    windowTitle = $selected.Title
    bounds = @{
      left = $left
      top = $top
      width = $clampedWidth
      height = $clampedHeight
    }
    imageDataUrl = "data:image/png;base64,$base64"
    capturedAt = [DateTime]::UtcNow.ToString("o")
  })
} catch {
  Write-Output (Write-JsonResult @{
    ok = $false
    errorCode = "CAPTURE_FAILED"
    message = $_.Exception.Message
  })
}
