# 建立桌面與開始功能表捷徑
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '找不到 Node.js，請先到 https://nodejs.org 下載安裝 LTS 版本，再重新執行安裝。'
  exit 1
}
$ws = New-Object -ComObject WScript.Shell
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $s = $ws.CreateShortcut((Join-Path $dir 'AI Office.lnk'))
  $s.TargetPath = $ps
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$here\launch-hidden.ps1`""
  $s.WorkingDirectory = $here
  $s.IconLocation = "$here\docs\icon.ico"
  $s.WindowStyle = 7
  $s.Description = 'AI Office'
  $s.Save()
}
Write-Host '完成！桌面與開始功能表都有「AI Office」了，雙擊即可開啟。'
Write-Host '請不要移動或刪除這個 ai-office 資料夾，捷徑會指向這裡。'
