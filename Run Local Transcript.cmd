@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found on this computer.
  echo.
  pause
  exit /b 1
)

start "" cmd /c "timeout /t 2 >nul && start http://localhost:4765"
echo Starting Local YouTube Transcript...
echo.
echo When you want to stop it, press Ctrl+C in this window.
echo.
npm start

echo.
echo The local transcript server stopped or could not start.
echo If the browser still works at http://localhost:4765, another copy is already running.
echo.
pause
