@echo off
setlocal
rem Always run from the folder containing this launcher, even after a double-click.
pushd "%~dp0"
if errorlevel 1 (
  echo Cannot open the Career Quest project folder.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install Node.js and run this file again.
  popd
  pause
  exit /b 1
)
echo Starting Career Quest. Keep this window open while using the app.
echo.
node server.js
set "career_quest_exit=%errorlevel%"
popd
if not "%career_quest_exit%"=="0" (
  echo.
  echo Career Quest stopped with an error. Read the message above.
  echo If the port is already in use, stop the previous server with Ctrl+C.
  pause
)
exit /b %career_quest_exit%
