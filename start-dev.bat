@echo off
setlocal

pushd "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo が見つかりません。Rust をインストールして PATH を確認してください。
  popd
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm が見つかりません。Node.js をインストールして PATH を確認してください。
  popd
  exit /b 1
)

echo [1/3] Building Rust core...
cargo build --manifest-path "%CD%\core\Cargo.toml"
if errorlevel 1 (
  echo [ERROR] Rust core のビルドに失敗しました。
  popd
  exit /b 1
)

if not exist "%CD%\core\target\debug\komehub_core.dll" (
  echo [ERROR] ビルド成果物 "%CD%\core\target\debug\komehub_core.dll" が見つかりません。
  popd
  exit /b 1
)

echo [2/3] Preparing native module...
copy /Y "%CD%\core\target\debug\komehub_core.dll" "%CD%\core\target\debug\komehub_core.node" >nul
if errorlevel 1 (
  echo [ERROR] komehub_core.node の準備に失敗しました。
  popd
  exit /b 1
)

echo [3/3] Starting app...
npm start
set EXIT_CODE=%ERRORLEVEL%

popd
exit /b %EXIT_CODE%
