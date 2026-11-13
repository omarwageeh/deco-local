@echo off
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:8686"
node src\server.js
pause
