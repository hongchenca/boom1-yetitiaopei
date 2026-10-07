@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24.14.0，安装后重新打开本文件。
  pause
  exit /b 1
)
node deploy\manage.cjs start
if errorlevel 1 pause
