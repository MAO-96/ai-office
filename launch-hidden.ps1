# AI Office 啟動器：在背景執行本機服務（不顯示黑色視窗），並以獨立視窗開啟辦公室
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
try {
  $node = (Get-Command node -ErrorAction Stop).Source
  Start-Process -FilePath $node -ArgumentList @('src\server\server.js', '--app') -WorkingDirectory $here -WindowStyle Hidden -ErrorAction Stop
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("無法啟動 AI Office：`n$($_.Exception.Message)`n`n請確認已安裝 Node.js（https://nodejs.org），或雙擊 start-windows.bat 查看詳細訊息。", 'AI Office') | Out-Null
}
