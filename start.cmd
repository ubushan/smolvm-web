@echo off
rem smolvm-web launcher for Windows.
rem smolvm serve listens on loopback TCP 127.0.0.1:18899 (no Unix sockets on Windows).
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=7777

where node >nul 2>nul || (echo [smolvm-web] Node.js 18+ is required: winget install OpenJS.NodeJS.LTS & exit /b 1)
if not defined SMOLVM_BIN (
  where smolvm >nul 2>nul || (echo [smolvm-web] smolvm.exe not found in PATH. Set SMOLVM_BIN=C:\path\to\smolvm.exe & exit /b 1)
)
net session >nul 2>nul || echo [smolvm-web] Warning: not elevated. smolvm on Windows is verified only as Administrator.

rem Open the browser a few seconds later, once the server is listening.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:%PORT%'"
node server.js --autostart %*
