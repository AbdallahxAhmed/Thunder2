# ============================================================
#  Thunder — Auto Setup & Launch Script
#  يشيك على كل حاجة ويشغّل المشروع بالكامل
# ============================================================

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$BinDir      = Join-Path $ProjectRoot "bin"
$VenvDir     = Join-Path $ProjectRoot ".venv"
$EnvFile     = Join-Path $ProjectRoot ".env"
$ReqFile     = Join-Path $ProjectRoot "requirements.txt"

# ── helpers ─────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "`n◆ $msg" -ForegroundColor Cyan }
function Write-OK    { param($msg) Write-Host "  ✔ $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "  ✘ $msg" -ForegroundColor Red }
function Write-Info  { param($msg) Write-Host "  → $msg" -ForegroundColor Gray }

function Add-ToBinPath {
    if ($env:PATH -notlike "*$BinDir*") {
        $env:PATH = "$BinDir;$env:PATH"
    }
}

function Get-RandomToken {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes) -replace '[^a-zA-Z0-9]', '' | Select-Object -First 1
    # fallback pure PS:
}

function New-SecureToken {
    $chars  = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    $rng    = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $result = ''
    $buf    = New-Object byte[] 1
    while ($result.Length -lt 32) {
        $rng.GetBytes($buf)
        $idx = $buf[0] % $chars.Length
        $result += $chars[$idx]
    }
    return $result
}

function Get-BinaryVersion {
    param($name)
    try {
        $out = & $name --version 2>&1 | Select-Object -First 1
        return $out
    } catch { return $null }
}

# ── 0. مجلد bin ──────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Add-ToBinPath

Write-Host @"

  ╔══════════════════════════════════════╗
  ║        Thunder Auto-Launch           ║
  ╚══════════════════════════════════════╝
"@ -ForegroundColor Magenta

# ── 1. Python ────────────────────────────────────────────────
Write-Step "Checking Python"

$PY = $null
foreach ($cmd in @("python","py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") { $PY = $cmd; break }
    } catch {}
}

if (-not $PY) {
    Write-Fail "Python 3 not found."
    Write-Host "  حمّله من: https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host "  وتأكد إن 'Add python.exe to PATH' معلّم أثناء التثبيت." -ForegroundColor Yellow
    exit 1
}

$pyVer = & $PY --version 2>&1
Write-OK "Found: $pyVer  (command: $PY)"

# ── 2. Virtual Environment ───────────────────────────────────
Write-Step "Virtual Environment"

if (-not (Test-Path (Join-Path $VenvDir "Scripts\python.exe"))) {
    Write-Info "Creating .venv ..."
    & $PY -m venv $VenvDir
    Write-OK "Created .venv"
} else {
    Write-OK ".venv already exists"
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip    = Join-Path $VenvDir "Scripts\pip.exe"
$VenvUvicorn = Join-Path $VenvDir "Scripts\uvicorn.exe"

# ── 3. Python Dependencies ───────────────────────────────────
Write-Step "Python Dependencies"

$installedRaw = & $VenvPip list --format=freeze 2>$null
$installed = $installedRaw -join "`n"

# نتحقق من fastapi كمؤشر إن الـ deps متثبتة
if ($installed -notmatch "fastapi") {
    Write-Info "Installing requirements.txt ..."
    & $VenvPip install -r $ReqFile --quiet
    Write-OK "All Python packages installed"
} else {
    Write-OK "Python packages already installed"
}

# ── 4. .env — RPC Token ──────────────────────────────────────
Write-Step "Environment Config (.env)"

$rpcToken   = $null
$envContent = @{}

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match "^([^#=]+)=(.*)$") {
            $envContent[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
}

if ($envContent.ContainsKey("ARIA2_RPC_SECRET") -and $envContent["ARIA2_RPC_SECRET"] -ne "") {
    $rpcToken = $envContent["ARIA2_RPC_SECRET"]
    Write-OK "ARIA2_RPC_SECRET found in .env"
} else {
    $rpcToken = New-SecureToken
    Write-Warn "ARIA2_RPC_SECRET not found — generating new token"

    # إضافة أو تحديث المتغير في الـ .env
    if (Test-Path $EnvFile) {
        $lines = Get-Content $EnvFile
        $found = $false
        $newLines = $lines | ForEach-Object {
            if ($_ -match "^ARIA2_RPC_SECRET") { $found = $true; "ARIA2_RPC_SECRET=$rpcToken" }
            else { $_ }
        }
        if (-not $found) { $newLines += "ARIA2_RPC_SECRET=$rpcToken" }
        $newLines | Set-Content $EnvFile
    } else {
        @(
            "# Thunder environment config",
            "ARIA2_RPC_SECRET=$rpcToken",
            "ARIA2_RPC_URL=http://localhost:6800/jsonrpc",
            "DOWNLOAD_DIR=./downloads"
        ) | Set-Content $EnvFile
    }
    Write-OK "Token saved to .env"
}

Write-Info "RPC Token: $($rpcToken.Substring(0,6))••••••••"

# ── 5. aria2c ────────────────────────────────────────────────
Write-Step "Checking aria2c"

$aria2Path = Get-Command "aria2c" -ErrorAction SilentlyContinue
if (-not $aria2Path) {
    $localAria2 = Join-Path $BinDir "aria2c.exe"
    if (Test-Path $localAria2) {
        Write-OK "aria2c found in bin\"
    } else {
        Write-Warn "aria2c not found — downloading..."
        try {
            # جيب آخر release من GitHub API
            $rel  = Invoke-RestMethod "https://api.github.com/repos/aria2/aria2/releases/latest"
            $asset = $rel.assets | Where-Object { $_.name -like "*win-64bit*" } | Select-Object -First 1
            if (-not $asset) {
                # fallback لو ما لقاش win-64bit
                $asset = $rel.assets | Where-Object { $_.name -like "*win*" -and $_.name -like "*.zip" } | Select-Object -First 1
            }
            $zipPath = Join-Path $env:TEMP "aria2.zip"
            Write-Info "Downloading $($asset.name) ..."
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
            $extractDir = Join-Path $env:TEMP "aria2_extract"
            Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
            $exeFile = Get-ChildItem -Path $extractDir -Filter "aria2c.exe" -Recurse | Select-Object -First 1
            Copy-Item $exeFile.FullName -Destination $localAria2
            Remove-Item $zipPath,$extractDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-OK "aria2c downloaded to bin\"
        } catch {
            Write-Fail "Failed to download aria2c: $_"
            Write-Host "  حمّله يدوياً من: https://github.com/aria2/aria2/releases" -ForegroundColor Yellow
            Write-Host "  وحط aria2c.exe في مجلد bin\" -ForegroundColor Yellow
        }
    }
} else {
    Write-OK "aria2c found on PATH: $($aria2Path.Source)"
}

# ── 6. N_m3u8DL-RE ───────────────────────────────────────────
Write-Step "Checking N_m3u8DL-RE"

$m3u8Path = Get-Command "N_m3u8DL-RE" -ErrorAction SilentlyContinue
if (-not $m3u8Path) {
    $localM3u8 = Join-Path $BinDir "N_m3u8DL-RE.exe"
    if (Test-Path $localM3u8) {
        Write-OK "N_m3u8DL-RE found in bin\"
    } else {
        Write-Warn "N_m3u8DL-RE not found — downloading..."
        try {
            $rel   = Invoke-RestMethod "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest"
            $asset = $rel.assets | Where-Object { $_.name -like "*win-x64*" -and $_.name -like "*.zip" } | Select-Object -First 1
            if (-not $asset) {
                $asset = $rel.assets | Where-Object { $_.name -like "*win*" -and $_.name -like "*.zip" } | Select-Object -First 1
            }
            $zipPath = Join-Path $env:TEMP "n_m3u8dl.zip"
            Write-Info "Downloading $($asset.name) ..."
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
            $extractDir = Join-Path $env:TEMP "n_m3u8dl_extract"
            Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
            $exeFile = Get-ChildItem -Path $extractDir -Filter "N_m3u8DL-RE.exe" -Recurse | Select-Object -First 1
            Copy-Item $exeFile.FullName -Destination $localM3u8
            Remove-Item $zipPath,$extractDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-OK "N_m3u8DL-RE downloaded to bin\"
        } catch {
            Write-Fail "Failed to download N_m3u8DL-RE: $_"
            Write-Host "  حمّله يدوياً من: https://github.com/nilaoda/N_m3u8DL-RE/releases" -ForegroundColor Yellow
            Write-Host "  وحط N_m3u8DL-RE.exe في مجلد bin\" -ForegroundColor Yellow
        }
    }
} else {
    Write-OK "N_m3u8DL-RE found on PATH: $($m3u8Path.Source)"
}

# ── 7. mp4decrypt (Bento4) ───────────────────────────────────
Write-Step "Checking mp4decrypt (Bento4)"

$mp4decPath = Get-Command "mp4decrypt" -ErrorAction SilentlyContinue
if (-not $mp4decPath) {
    $localMp4dec = Join-Path $BinDir "mp4decrypt.exe"
    if (Test-Path $localMp4dec) {
        Write-OK "mp4decrypt found in bin\"
    } else {
        Write-Warn "mp4decrypt not found — downloading Bento4..."
        try {
            # Bento4 بيرفع على موقعه مباشرة — نجيب الرابط من صفحة التحميل
            $page = Invoke-WebRequest -Uri "https://www.bento4.com/downloads/" -UseBasicParsing
            $dlUrl = ($page.Links | Where-Object { $_.href -like "*x86_64-microsoft-win32*" } | Select-Object -First 1).href
            if (-not $dlUrl) {
                # fallback: رابط ثابت لآخر نسخة معروفة
                $dlUrl = "https://www.bok.net/Bento4/binaries/Bento4-SDK-1-6-0-641.x86_64-microsoft-win32.zip"
            }
            $zipName    = Split-Path $dlUrl -Leaf
            $zipPath    = Join-Path $env:TEMP "bento4.zip"
            $extractDir = Join-Path $env:TEMP "bento4_extract"
            Write-Info "Downloading $zipName ..."
            Invoke-WebRequest -Uri $dlUrl -OutFile $zipPath
            Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
            $exeFile = Get-ChildItem -Path $extractDir -Filter "mp4decrypt.exe" -Recurse | Select-Object -First 1
            Copy-Item $exeFile.FullName -Destination $localMp4dec
            Remove-Item $zipPath,$extractDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-OK "mp4decrypt downloaded to bin\"
        } catch {
            Write-Fail "Failed to download Bento4: $_"
            Write-Host "  حمّله يدوياً من: https://www.bento4.com/downloads/" -ForegroundColor Yellow
            Write-Host "  وخد mp4decrypt.exe من مجلد bin\ وحطه في .\bin\" -ForegroundColor Yellow
        }
    }
} else {
    Write-OK "mp4decrypt found on PATH: $($mp4decPath.Source)"
}

# ── 8. شغّل aria2c ───────────────────────────────────────────
Write-Step "Starting aria2c RPC daemon"

# شيك لو aria2c شغال خلاص
$aria2Running = $false
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:6800/jsonrpc" `
        -Method Post `
        -Body '{"jsonrpc":"2.0","method":"aria2.getVersion","id":1,"params":[]}' `
        -ContentType "application/json" `
        -ErrorAction SilentlyContinue
    if ($resp.result) { $aria2Running = $true }
} catch {}

if ($aria2Running) {
    Write-OK "aria2c already running on :6800"
} else {
    $aria2Cmd = Get-Command "aria2c" -ErrorAction SilentlyContinue
    $aria2Exe = if ($aria2Cmd) { $aria2Cmd.Source } else { Join-Path $BinDir "aria2c.exe" }

    if (Test-Path $aria2Exe) {
        $tokenArg = "--rpc-secret=$rpcToken"
        Start-Process -FilePath $aria2Exe `
            -ArgumentList "--enable-rpc", "--rpc-listen-all=false", "--rpc-listen-port=6800", $tokenArg, "--log-level=warn" `
            -WindowStyle Hidden
        Start-Sleep -Seconds 2

        # تحقق إنه اشتغل
        try {
            $resp = Invoke-RestMethod -Uri "http://localhost:6800/jsonrpc" `
                -Method Post `
                -Body "{`"jsonrpc`":`"2.0`",`"method`":`"aria2.getVersion`",`"id`":1,`"params`":[`"token:$rpcToken`"]}" `
                -ContentType "application/json"
            Write-OK "aria2c started — version $($resp.result.version)"
        } catch {
            Write-Warn "aria2c may not have started correctly"
        }
    } else {
        Write-Warn "aria2c.exe not found — skipping (download hijacking won't work)"
    }
}

# ── 9. تحقق من downloads folder ──────────────────────────────
Write-Step "Checking downloads folder"
$dlDir = Join-Path $ProjectRoot "downloads"
if (-not (Test-Path $dlDir)) {
    New-Item -ItemType Directory -Path $dlDir | Out-Null
    Write-OK "Created downloads\"
} else {
    Write-OK "downloads\ exists"
}

# ── 10. ملخص Health Check ─────────────────────────────────────
Write-Step "Pre-flight check"

$checks = @{
    "Python venv"    = Test-Path (Join-Path $VenvDir "Scripts\python.exe")
    "fastapi"        = ($installed -match "fastapi")
    "aria2c"         = ($aria2Running -or (Test-Path (Join-Path $BinDir "aria2c.exe")) -or (Get-Command "aria2c" -ErrorAction SilentlyContinue))
    "N_m3u8DL-RE"   = ((Test-Path (Join-Path $BinDir "N_m3u8DL-RE.exe")) -or (Get-Command "N_m3u8DL-RE" -ErrorAction SilentlyContinue))
    "mp4decrypt"     = ((Test-Path (Join-Path $BinDir "mp4decrypt.exe")) -or (Get-Command "mp4decrypt" -ErrorAction SilentlyContinue))
    "yt-dlp"         = [bool](Get-Command "yt-dlp" -ErrorAction SilentlyContinue)
    ".env token"     = ($rpcToken.Length -gt 0)
}

$allGood = $true
foreach ($k in $checks.Keys) {
    if ($checks[$k]) { Write-OK $k } else { Write-Warn "$k — missing"; $allGood = $false }
}

# ── 11. شغّل uvicorn ─────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkGray
if ($allGood) {
    Write-Host "  🚀 All checks passed — starting Thunder!" -ForegroundColor Green
} else {
    Write-Host "  ⚠  Some checks failed — starting anyway" -ForegroundColor Yellow
}
Write-Host "  Backend: http://127.0.0.1:8000" -ForegroundColor Cyan
Write-Host "  Docs:    http://127.0.0.1:8000/docs" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host "══════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host ""

Set-Location $ProjectRoot
& $VenvUvicorn src.main:app --host 127.0.0.1 --port 8000 --reload