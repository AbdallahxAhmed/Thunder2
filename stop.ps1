# stop.ps1
Write-Host "Stopping Thunder..." -ForegroundColor Cyan
taskkill /IM aria2c.exe /F 2>$null
taskkill /IM uvicorn.exe /F 2>$null
Write-Host "Done." -ForegroundColor Green