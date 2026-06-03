@echo off
cd /d "%~dp0"
start "" npx serve -l 3000 --no-clipboard
timeout /t 2 /nobreak >nul
npm start
