# Installs (or updates) Claude Island for the current user. No admin needed.
#   1. Stops the island if it's running
#   2. Copies the packaged app to %LOCALAPPDATA%\Programs\Claude Island
#   3. Adds a Start Menu shortcut
#   4. Starts it
# Run "npm run package" first. Then: npm run install-app

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\dist\Claude Island-win32-x64"
$target = Join-Path $env:LOCALAPPDATA "Programs\Claude Island"
$exe = Join-Path $target "Claude Island.exe"

if (-not (Test-Path $source)) { throw "Packaged app not found. Run 'npm run package' first." }

# 1. Stop the running island (installed or dev copy), so its files can be replaced.
Get-Process -Name "Claude Island", "electron" -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*Claude Island*" -or $_.Path -like "*claude-island*" } |
  Stop-Process -Force
Start-Sleep -Milliseconds 800

# 2. Copy the app. Keep only the English language pack: the island has no
#    translated screens, and the other ~50 packs are about 49 MB.
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Copy-Item $source $target -Recurse
Get-ChildItem (Join-Path $target "locales") -Filter *.pak |
  Where-Object { $_.Name -ne "en-US.pak" } |
  Remove-Item -Force

# 3. Shortcuts: Start Menu (search "Claude Island") and Desktop.
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
  $shortcutPath = Join-Path $folder "Claude Island.lnk"
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $exe
  $shortcut.WorkingDirectory = $target
  $shortcut.Description = "Claude Code sessions in a notch"
  $shortcut.Save()
  Write-Output "Shortcut: $shortcutPath"
}

# 4. Start it.
Start-Process $exe
$size = [math]::Round(((Get-ChildItem $target -Recurse | Measure-Object Length -Sum).Sum) / 1MB)
Write-Output "Installed to $target ($size MB)."
