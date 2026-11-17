# Start the Claude for Zen chat panel server whenever you log in to Windows.
#
#   powershell -File scripts\autostart.ps1            add the login item and start it now
#   powershell -File scripts\autostart.ps1 -Remove    remove the login item
#
# It adds one shortcut to your Startup folder; nothing else is changed.

param([switch]$Remove)

$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude for Zen chat.lnk'

if ($Remove) {
  if (Test-Path $shortcut) { Remove-Item $shortcut -Confirm:$false; "Removed $shortcut" } else { 'No login item to remove.' }
  return
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$server = Join-Path $root 'chat\server.js'

$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$link.TargetPath = (Get-Command powershell).Source
# Hidden window: the server has no interface of its own.
$link.Arguments = "-NoProfile -WindowStyle Hidden -Command `"& '$node' '$server'`""
$link.WorkingDirectory = $root
$link.WindowStyle = 7
$link.Description = 'Chat panel server for the Claude for Zen add-on'
$link.Save()
"Added login item: $shortcut"

Start-Process -FilePath $link.TargetPath -ArgumentList $link.Arguments -WorkingDirectory $root -WindowStyle Hidden
'Started the chat server: http://127.0.0.1:47810'
