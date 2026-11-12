# Trusted worker source. Host sets these variables in the inline command; no script-file policy is changed.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ocrClock = [Diagnostics.Stopwatch]::StartNew()
function Await-Ocr($operation, [Type]$resultType) {
  $remaining = [Math]::Max(1, 28000 - [int]$ocrClock.ElapsedMilliseconds)
  $task = $script:ocrAsTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait($remaining)) { throw 'MATERIALS_OCR_FAILED' }
  return $task.Result
}
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  $script:ocrAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  if ($null -eq $script:ocrAsTask) { throw 'MATERIALS_OCR_UNAVAILABLE' }
  if ($ocrLanguage -eq 'auto') {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  } else {
    $language = [Windows.Globalization.Language]::new($ocrLanguage)
    if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) { throw 'MATERIALS_OCR_UNAVAILABLE' }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  }
  if ($null -eq $engine) { throw 'MATERIALS_OCR_UNAVAILABLE' }
  $source = [IO.File]::Open($ocrInputPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($source.Length -lt 1 -or $source.Length -gt 26214400) { throw 'MATERIALS_IMAGE_REJECTED' }
    $bytes = New-Object byte[] ([int]$source.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $source.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { throw 'MATERIALS_IMAGE_REJECTED' }
      $offset += $count
    }
    if ($source.ReadByte() -ne -1) { throw 'MATERIALS_IMAGE_REJECTED' }
  } finally { $source.Dispose() }
  $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  try {
    $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
    try {
      $writer.WriteBytes($bytes)
      [void](Await-Ocr ($writer.StoreAsync()) ([uint32]))
      [void](Await-Ocr ($writer.FlushAsync()) ([bool]))
      [void]$writer.DetachStream()
    } finally { $writer.Dispose() }
    $stream.Seek(0)
    $decoder = Await-Ocr ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($decoder.PixelWidth -lt 1 -or $decoder.PixelHeight -lt 1 -or $decoder.PixelWidth -gt 10000 -or $decoder.PixelHeight -gt 10000 -or ([double]$decoder.PixelWidth * $decoder.PixelHeight) -gt 25000000) { throw 'MATERIALS_IMAGE_REJECTED' }
    $bitmap = Await-Ocr ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $recognized = Await-Ocr ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines = @($recognized.Lines | ForEach-Object {
        [ordered]@{ text = $_.Text; words = @($_.Words | ForEach-Object {
          [ordered]@{ text = $_.Text; box = [ordered]@{ x = $_.BoundingRect.X; y = $_.BoundingRect.Y; width = $_.BoundingRect.Width; height = $_.BoundingRect.Height } }
        }) }
      })
      [ordered]@{ ok = $true; language = $engine.RecognizerLanguage.LanguageTag; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lines = $lines } | ConvertTo-Json -Depth 9 -Compress
    } finally { $bitmap.Dispose() }
  } finally { $stream.Dispose() }
} catch {
  $code = 'MATERIALS_OCR_FAILED'
  if ($_.Exception.Message -in @('MATERIALS_OCR_UNAVAILABLE', 'MATERIALS_IMAGE_REJECTED')) { $code = $_.Exception.Message }
  [ordered]@{ ok = $false; code = $code } | ConvertTo-Json -Compress
  exit 1
}
