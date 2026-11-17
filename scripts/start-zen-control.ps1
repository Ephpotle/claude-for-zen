# Start Zen with remote control switched on, so the chat panel's "Zen Spaces and
# tabs" option can reach Spaces, folders and tabs.
#
# While Zen runs this way:
#   - any program on this computer can drive the browser (ports 2828 and 9222,
#     this machine only, no password);
#   - web pages can tell the browser is automatable (navigator.webdriver), and
#     some sites answer that with captchas or refused sign-ins.
# Start Zen the normal way when you do not need Claude to reorganise it.
#
#   powershell -File scripts\start-zen-control.ps1              start Zen with remote control
#   powershell -File scripts\start-zen-control.ps1 -Shortcut    also put a shortcut on the Desktop

param([switch]$Shortcut)

$zen = 'C:\Program Files\Zen Browser\zen.exe'

if ($Shortcut) {
  $path = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Zen (Claude control).lnk'
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $link.TargetPath = (Get-Command powershell).Source
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $link.IconLocation = "$zen,0"
  $link.Description = 'Zen with remote control on, for Claude for Zen (Spaces and tabs)'
  $link.Save()
  "Shortcut created: $path"
  return
}

# Flags are ignored if Zen is already running on the profile, so insist on a clean start.
$running = Get-CimInstance Win32_Process -Filter "Name='zen.exe'" |
  Where-Object { $_.CommandLine -notmatch 'contentproc' -and $_.CommandLine -notmatch '-profile ' }
if ($running) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    'Zen is already running. Quit it completely (Ctrl+Shift+Q), then use this shortcut again.',
    'Zen (Claude control)') | Out-Null
  return
}

$env:MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1'
Start-Process -FilePath $zen -ArgumentList '--marionette', '--remote-debugging-port', '9222'
