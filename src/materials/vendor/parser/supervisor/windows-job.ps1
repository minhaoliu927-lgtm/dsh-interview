param([ValidateSet('directory','job','wait-gone')][string]$Mode, [string]$ResourceDirectory, [string]$Directory, [string]$ConfigPath, [string]$ReceiptPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($Mode -eq 'wait-gone') {
    $receipt = [IO.File]::ReadAllText($ReceiptPath) | ConvertFrom-Json
    if (-not $receipt.childPid -or -not $receipt.childCreationUtcMs) { throw 'PARSER_CHILD_IDENTITY_REQUIRED' }
    try { $owned = [Diagnostics.Process]::GetProcessById([int]$receipt.childPid) }
    catch [ArgumentException] { [Console]::Out.Write('{"absent":true,"reason":"pid-not-present"}'); exit 0 }
    try {
      $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
      $created = [long](($owned.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds)
      if ([Math]::Abs($created - [long]$receipt.childCreationUtcMs) -gt 2) {
        [Console]::Out.Write('{"absent":true,"reason":"old-process-identity-gone"}'); exit 0
      }
      if (-not $owned.WaitForExit(10000)) { throw 'PARSER_CHILD_STILL_RUNNING' }
      [Console]::Out.Write('{"absent":true,"reason":"owned-process-exited"}'); exit 0
    } finally { $owned.Dispose() }
  }
  $source = [IO.File]::ReadAllText((Join-Path $ResourceDirectory 'windows-job.cs'))
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  if ($Mode -eq 'directory') {
    [Console]::Out.Write([ZhijingParserPlatform]::CreatePrivateDirectory($Directory)); exit 0
  }
  $configuration = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
  $names = New-Object 'Collections.Generic.List[string]'
  $values = New-Object 'Collections.Generic.List[string]'
  foreach ($property in $configuration.env.PSObject.Properties) { $names.Add($property.Name); $values.Add([string]$property.Value) }
  $arguments = [string[]]@($configuration.arguments | ForEach-Object { [string]$_ })
  $code = [ZhijingParserPlatform]::Run([string]$configuration.nodeExecutable, $arguments, [string]$configuration.cwd,
    $names.ToArray(), $values.ToArray(), [int]$configuration.jobMemoryMb, [uint32]$configuration.parentPid,
    [long]$configuration.parentStartedUtcMs, [string]$configuration.receipt)
  exit $code
} catch {
  [Console]::Error.Write('PARSER_PLATFORM_OPERATION_FAILED')
  exit 78
}
