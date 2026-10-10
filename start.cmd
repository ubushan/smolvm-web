@echo off
rem smolvm-web launcher for Windows.
rem smolvm serve listens on loopback TCP 127.0.0.1:18899 (no Unix sockets on Windows).
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=7777

where node >nul 2>nul || (echo [smolvm-web] Node.js is required: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)

rem smolvm.exe: SMOLVM_BIN, else PATH, else unpacked anywhere under %USERPROFILE%\smolvm
rem (or C:\smolvm, the earlier install path).
if not defined SMOLVM_BIN (
  where smolvm >nul 2>nul || (
    for %%D in ("%USERPROFILE%\smolvm" "C:\smolvm") do if exist "%%~D" for /r "%%~D" %%F in (smolvm.exe) do if exist "%%F" if not defined SMOLVM_BIN set "SMOLVM_BIN=%%F"
  )
)
if not defined SMOLVM_BIN (
  where smolvm >nul 2>nul || (echo [smolvm-web] smolvm.exe not found: unpack smolvm into %USERPROFILE%\smolvm or set SMOLVM_BIN & pause & exit /b 1)
)
rem Administrator rights are not required: only the symlink right for smolvm's first rootfs
rem extraction (Developer Mode, the "Create symbolic links" right, or one elevated first run).
rem smolvm-web checks it at startup and in the UI.

rem Open the browser a few seconds later, once the server is listening (no PowerShell).
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://127.0.0.1:%PORT%"
node server.js --autostart %*
