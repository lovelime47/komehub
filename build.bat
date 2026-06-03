@echo off
setlocal
REM Build the distributable (installer + portable) into the dist\ folder.
REM Rust release build + electron-builder. Server upload / VirusTotal is deploy.sh.
REM ASCII-only + CRLF on purpose so cmd.exe parses this reliably.

pushd "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo not found in PATH. Install Rust, then re-open the terminal.
  popd
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found in PATH. Install Node.js, then re-open the terminal.
  popd
  pause
  exit /b 1
)

echo === Live Comment Hub : build distributable ===
echo Builds installer + portable into dist\  (Rust release + electron-builder).
echo This takes about 3-5 minutes...
echo.

call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. Check the log above.
  popd
  pause
  exit /b 1
)

echo.
echo === Build complete ===
echo Artifacts are in the dist\ folder:
echo   "Live Comment Hub Setup *.exe"      (installer)
echo   "Live Comment Hub-*-portable.exe"   (portable)
echo.

popd
pause
exit /b 0
