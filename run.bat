@echo off
title Thunder
echo.
echo   ========================================
echo        Thunder - Starting Up
echo   ========================================
echo.

cd /d "%~dp0"

echo   Starting server...
start "Thunder Server" cmd /k "cd /d "%~dp0" && .venv\Scripts\python.exe -m uvicorn src.main:app --host 127.0.0.1 --port 8000"

echo   Waiting for server...
set attempts=0

:wait_loop
if %attempts% geq 10 goto open_dashboard
timeout /t 1 /nobreak >nul 2>nul
set /a attempts+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8000/api/health' -TimeoutSec 2 -UseBasicParsing; if($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
if %errorlevel% equ 0 goto server_ready
echo   ... attempt %attempts%/10
goto wait_loop

:server_ready
echo.
echo   Server is ready!

:open_dashboard
echo   Opening dashboard...
start "" "http://localhost:8000/dashboard/index.html"
echo.
echo   Thunder is running in the other window.
echo   Close that window to stop the server.
echo.
pause
