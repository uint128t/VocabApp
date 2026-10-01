@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] node not found. Install Node.js or add it to PATH.
  exit /b 1
)

if not exist .env (
  echo [X] Missing VocabApp\.env
  echo     Create .env next to this script and fill in a VOCAB_KEY_NAME=value line.
  exit /b 1
)

rem The port lives in settings.json (settings page). Fall back to 5317 when the
rem file is missing or unreadable. LAN binding is also a settings-page toggle.
set PORT=5317
for /f "usebackq delims=" %%p in (`node -e "try{const p=require('./settings.json').port;process.stdout.write(String(p>=1024&&p<=65535?p:5317))}catch(e){process.stdout.write('5317')}" 2^>nul`) do set PORT=%%p

netstat -ano | findstr LISTENING | findstr /c:":%PORT% " >nul
if not errorlevel 1 (
  echo [i] Already running on port %PORT%. Opening the browser.
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

echo [i] Starting VocabApp on port %PORT% ...
start "VocabApp" cmd /k "node server.js"

node -e "const u='http://127.0.0.1:'+process.argv[1]+'/api/settings';(async()=>{for(let i=0;i<40;i++){try{if((await fetch(u)).ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,300))}process.exit(1)})()" %PORT%
if errorlevel 1 (
  echo [X] Startup timed out. Check the "VocabApp" window for the error.
  exit /b 1
)

echo [OK] Ready: http://127.0.0.1:%PORT%/  (close the other window to stop)
start "" "http://127.0.0.1:%PORT%/"
exit /b 0
