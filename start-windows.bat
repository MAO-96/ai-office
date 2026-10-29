@echo off
chcp 65001 >nul
title AI Office
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，請先到 https://nodejs.org 下載安裝 LTS 版本，裝好後再雙擊這個檔案。
  pause
  exit /b 1
)
echo 正在啟動 AI 辦公室（偵錯模式：這個黑色視窗會顯示詳細訊息）。
echo 平常使用請改用桌面的 AI Office 捷徑，就不會出現這個視窗。
echo.
node src\server\server.js --app
pause
