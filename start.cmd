@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "TEMP=D:\codex\tmp\funding-arb-desktop"
set "TMP=%TEMP%"
set "npm_config_cache=D:\codex\cache\npm"
if not exist "%TEMP%" mkdir "%TEMP%"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer first.
  pause
  exit /b 1
)
if not exist node_modules\.bin\tsx.cmd call npm install
if errorlevel 1 goto failed
if not exist dist\index.html call npm run build
if errorlevel 1 goto failed
node scripts\start-app.mjs %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo Startup failed. Please check the message above.
pause
exit /b 1
