@echo off
setlocal

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":4765 .*LISTENING"') do (
  set "FOUND=1"
  echo Stopping server process %%P...
  taskkill /PID %%P /F >nul 2>nul
)

if not defined FOUND (
  echo No Local YouTube Transcript server is running on port 4765.
)

echo.
pause
