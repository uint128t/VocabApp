@echo off
setlocal
cd /d "%~dp0"

set PORT=5317
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set PORT=%%b

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

netstat -ano | findstr /c:"127.0.0.1:%PORT%" | findstr LISTENING >nul
if not errorlevel 1 (
  echo [i] Already running on port %PORT%. Opening the browser.
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

echo [i] Starting Vocabulary helper on port %PORT% ...
start "Vocabulary Helper" cmd /k "node server.js"

node -e "const u='http://127.0.0.1:'+process.argv[1]+'/api/config';(async()=>{for(let i=0;i<40;i++){try{if((await fetch(u)).ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,300))}process.exit(1)})()" %PORT%
if errorlevel 1 (
  echo [X] Startup timed out. Check the "Vocabulary Helper" window for the error.
  exit /b 1
)

echo [OK] Ready: http://127.0.0.1:%PORT%/  (close the other window to stop)
start "" "http://127.0.0.1:%PORT%/"
exit /b 0
