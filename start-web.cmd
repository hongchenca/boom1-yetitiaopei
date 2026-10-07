@echo off
if /i "%~1"=="--run" goto run
"%ComSpec%" /d /k ""%~f0" --run"
exit /b

:run
setlocal
title Yetitiaopei Web Console
cd /d "%~dp0"
set "YETI_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined YETI_NODE set "YETI_NODE=%%N"
if not defined YETI_NODE if exist "E:\Program Files\nodejs\node.exe" set "YETI_NODE=E:\Program Files\nodejs\node.exe"
if not defined YETI_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "YETI_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined YETI_NODE (
  echo Node.js not found. Please install Node.js 24.14.x and try again.
  pause
  exit /b 1
)
echo Starting Yetitiaopei web console. Keep this window open.
echo Press Ctrl+C to stop the server.
"%YETI_NODE%" "%~dp0web_server\start-local.cjs"
if errorlevel 1 (
  echo Startup failed. See the error above.
  pause
  exit /b 1
)
echo Server stopped. This window can now be closed.
