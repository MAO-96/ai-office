#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js，請先到 https://nodejs.org 下載安裝 LTS 版本，裝好後再雙擊這個檔案。"
  read -p "按 Enter 關閉"; exit 1
fi
echo "正在啟動 AI 辦公室，會開啟獨立視窗。使用期間請不要關閉這個視窗。"
node src/server/server.js --app
