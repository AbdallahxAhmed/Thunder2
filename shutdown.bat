@echo off
title Thunder - Shutdown
echo Stopping Thunder Course Downloader...

:: Kill uvicorn/python process on port 8000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000') do (
    taskkill /f /pid %%a >nul 2>&1
    echo Terminated server process %%a on port 8000.
)

:: Kill aria2c if running
taskkill /f /im aria2c.exe >nul 2>&1
echo Terminated aria2c process.

echo Done.
pause
