@echo off
cd /d "%~dp0"
if not exist node_modules\ssh2 call npm install --omit=optional
start "" /b cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:8686"
node src\server.js
pause
