# Regenerates a valid multi-resolution .ico (truecolor+alpha PNG frames) from
# icons/icon.png, so tauri-build's icon decoder accepts it (the previous .ico
# embedded an indexed-color PNG frame -> "Unsupported PNG color type: Indexed").
# System.Drawing saves 32bppArgb bitmaps as PNG color type 6 (RGBA), which is
# supported. Writes the result to every target path passed on the command line.
param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string[]]$Targets
)

Add-Type -AssemblyName System.Drawing

$sizes = @(16,24,32,48,64,128,256)
$src = [System.Drawing.Image]::FromFile($Source)

$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0,0,$s,$s)))
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $frames += ,@{ Size = $s; Bytes = $ms.ToArray() }
  $ms.Dispose()
}
$src.Dispose()

# Assemble the ICO container: ICONDIR(6) + N*ICONDIRENTRY(16) + image data.
$count = $frames.Count
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)

$bw.Write([UInt16]0)   # reserved
$bw.Write([UInt16]1)   # type = icon
$bw.Write([UInt16]$count)

$offset = 6 + (16 * $count)
foreach ($f in $frames) {
  $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }  # 0 means 256
  $bw.Write([Byte]$dim)          # width
  $bw.Write([Byte]$dim)          # height
  $bw.Write([Byte]0)             # color count (0 = truecolor)
  $bw.Write([Byte]0)             # reserved
  $bw.Write([UInt16]1)           # color planes
  $bw.Write([UInt16]32)          # bits per pixel
  $bw.Write([UInt32]$f.Bytes.Length)  # bytes in resource
  $bw.Write([UInt32]$offset)     # image offset
  $offset += $f.Bytes.Length
}
foreach ($f in $frames) { $bw.Write($f.Bytes) }
$bw.Flush()
$icoBytes = $out.ToArray()
$bw.Dispose(); $out.Dispose()

foreach ($t in $Targets) {
  $dir = Split-Path -Parent $t
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllBytes($t, $icoBytes)
  Write-Output ("wrote {0} ({1} bytes, {2} frames)" -f $t, $icoBytes.Length, $count)
}
