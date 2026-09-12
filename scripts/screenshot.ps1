<#
.SYNOPSIS
  Screenshot a page with headless Chrome, and optionally dump its DOM.

.DESCRIPTION
  Chrome cannot start under DSH's confined sandbox modes. Its Mojo IPC creates a
  named pipe and needs write access to the client end, which the restricting SID
  on a confined token is not granted, so Chrome dies with:

    FATAL:mojo\public\cpp\platform\platform_channel.cc:108  Access is denied. (0x5)

  `dsh-sandbox-windows-acl` documents this: confined grandchildren cannot open
  named pipes. So this script has to run with the sandbox at `danger-full-access`
  (approve the escalation when asked), or from a terminal outside DSH entirely.

  It deliberately uses Start-Process rather than `& chrome ... > file`: piping a
  native command's output through PowerShell here yields no output at all and an
  empty exit code, which is indistinguishable from a silent failure.

.EXAMPLE
  .\screenshot.ps1
  .\screenshot.ps1 -Url http://127.0.0.1:8787/ -Out .\floor2.png -DumpDom
#>
param(
  [string]$Url = 'http://127.0.0.1:8787/',
  [string]$Out = (Join-Path $PSScriptRoot '..\.screenshots\office.png'),
  [int]$Width = 1600,
  [int]$Height = 1000,
  [int]$VirtualTimeMs = 25000,
  [switch]$DumpDom
)

$ErrorActionPreference = 'Stop'

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { throw 'No Chrome or Edge found.' }

$Out = [IO.Path]::GetFullPath($Out)
$dir = Split-Path -Parent $Out
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# A fresh profile every run: a reused one can make Chrome hand the request to an
# already-running browser and exit without doing any work.
$profile = Join-Path ([IO.Path]::GetTempPath()) "dsh-shot-$([guid]::NewGuid().ToString('N').Substring(0,8))"

$domPath = [IO.Path]::ChangeExtension($Out, '.html')
$errPath = [IO.Path]::ChangeExtension($Out, '.err.txt')

$chromeArgs = @(
  '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--disable-breakpad', '--disable-crash-reporter', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', "--user-data-dir=$profile",
  "--window-size=$Width,$Height", "--virtual-time-budget=$VirtualTimeMs",
  "--screenshot=$Out"
)
if ($DumpDom) { $chromeArgs += @('--dump-dom') }
$chromeArgs += $Url

$proc = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -NoNewWindow -Wait -PassThru `
          -RedirectStandardOutput $domPath -RedirectStandardError $errPath

$bytes = if (Test-Path $Out) { (Get-Item $Out).Length } else { 0 }
Write-Host ("chrome exit {0}; {1} ({2:N0} bytes)" -f $proc.ExitCode, $Out, $bytes)
if ($proc.ExitCode -ne 0 -or $bytes -eq 0) {
  Write-Host '--- stderr ---'
  Get-Content $errPath -ErrorAction SilentlyContinue | Select-Object -First 12
  exit 1
}
exit 0
