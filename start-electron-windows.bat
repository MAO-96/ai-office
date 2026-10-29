@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 進階：桌面視窗版，需要能下載 Electron。一般使用請用 start-windows.bat。
if not exist node_modules call npm install
if not exist node_modules\electron\path.txt node node_modules\electron\install.js
call npm run electron
pause
