# COTW Scout - beta setup script for Windows.
# Verifies your environment, clones the repo if needed, and installs dependencies.
#
# Run in PowerShell (right-click Start -> "Terminal" or "Windows PowerShell"):
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\beta-setup.ps1
#
# Or in one line from anywhere:
#   iwr -useb https://raw.githubusercontent.com/CoderofTheWest/cotw-scout/main/scripts/beta-setup.ps1 | iex

$ErrorActionPreference = 'Stop'

function Say-Step { param($m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Say-Ok   { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Say-Warn { param($m) Write-Host "  [!] $m" -ForegroundColor Yellow }
function Say-Fail { param($m) Write-Host "  [x] $m" -ForegroundColor Red }
function Say-Info { param($m) Write-Host "  -> $m" -ForegroundColor Gray }

$Failures = 0
function Note-Failure { $script:Failures++ }

# ----------------------------------------------------------------------
# 1. Platform - Windows 10/11 (x64)
# ----------------------------------------------------------------------
Say-Step "Checking platform"
if ($env:OS -ne 'Windows_NT') {
    Say-Fail "This setup is for Windows. Detected: $env:OS"
    exit 1
}
$osVer = (Get-CimInstance Win32_OperatingSystem).Caption
Say-Ok "$osVer"

# ----------------------------------------------------------------------
# 2. Node.js (>= 22.14)
# ----------------------------------------------------------------------
Say-Step "Checking Node.js (>= 22.14.0)"
$nodeMin = [version]'22.14.0'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Say-Fail "Node.js not found."
    Say-Fail "Download the LTS installer from https://nodejs.org and run it, then re-run this script."
    Note-Failure
} else {
    $nodeRaw = (node -e "process.stdout.write(process.versions.node)")
    try {
        $nodeVer = [version]$nodeRaw
        if ($nodeVer -lt $nodeMin) {
            Say-Fail "Node $nodeRaw found, but $nodeMin+ required."
            Say-Fail "Upgrade from https://nodejs.org"
            Note-Failure
        } else {
            Say-Ok "Node $nodeRaw"
        }
    } catch {
        Say-Warn "Could not parse Node version '$nodeRaw'; skipping version check."
    }
}

# ----------------------------------------------------------------------
# 3. Git
# ----------------------------------------------------------------------
Say-Step "Checking Git"
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Say-Fail "Git not found."
    Say-Fail "Install Git for Windows from https://git-scm.com/download/win"
    Note-Failure
} else {
    $gitVer = (git --version) -replace 'git version ', ''
    Say-Ok "Git $gitVer"
}

# ----------------------------------------------------------------------
# 4. Ollama (installed)
# ----------------------------------------------------------------------
Say-Step "Checking Ollama"
$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
$ollamaPresent = $false
if ($ollamaCmd) {
    Say-Ok "Ollama installed"
    $ollamaPresent = $true
} else {
    Say-Fail "Ollama not found."
    Say-Fail "Download from https://ollama.com/download/windows and run the installer."
    Note-Failure
}

# ----------------------------------------------------------------------
# 5. Ollama (running on 11434)
# ----------------------------------------------------------------------
if ($ollamaPresent) {
    Say-Step "Checking Ollama daemon (localhost:11434)"
    $ollamaUp = $false
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://localhost:11434/api/version' -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ollamaUp = $true }
    } catch { $ollamaUp = $false }

    if ($ollamaUp) {
        Say-Ok "Ollama is running"
    } else {
        Say-Warn "Ollama is installed but not running."
        Say-Warn "Launch Ollama from the Start menu (or run 'ollama serve' in another PowerShell), then re-run this script."
        Note-Failure
    }
}

# ----------------------------------------------------------------------
# 6. Ollama glm-5:cloud model
# ----------------------------------------------------------------------
if ($ollamaPresent -and $Failures -eq 0) {
    Say-Step "Checking glm-5:cloud model"
    $hasGlm = $false
    try {
        $list = (ollama list 2>$null) -split "`n"
        foreach ($line in $list | Select-Object -Skip 1) {
            if (($line -split '\s+')[0] -eq 'glm-5:cloud') { $hasGlm = $true; break }
        }
    } catch { $hasGlm = $false }

    if ($hasGlm) {
        Say-Ok "glm-5:cloud already pulled"
    } else {
        Say-Warn "glm-5:cloud not pulled yet - attempting now (requires a free Ollama account)."
        Say-Info "If you see 'please sign in', run: ollama signin   then re-run this script."
        try {
            ollama pull glm-5:cloud
            Say-Ok "glm-5:cloud pulled"
        } catch {
            Say-Fail "Pull failed. Try 'ollama signin' then re-run this script."
            Note-Failure
        }
    }
}

# ----------------------------------------------------------------------
# 7. Clone or locate the repo
# ----------------------------------------------------------------------
$RepoName = 'cotw-scout'
$RepoUrl  = 'https://github.com/CoderofTheWest/cotw-scout.git'

# Where are we? If the script was executed from inside the repo, stay put.
# Otherwise clone into $env:USERPROFILE\cotw-scout.
$RepoRoot = $null
$scriptRoot = $null
try { $scriptRoot = Split-Path -Parent -Path $MyInvocation.MyCommand.Path } catch { $scriptRoot = $null }

if ($scriptRoot -and (Test-Path (Join-Path $scriptRoot '..\package.json'))) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot '..')).Path
    Say-Step "Using existing checkout"
    Say-Ok "Repo at $RepoRoot"
} else {
    $RepoRoot = Join-Path $env:USERPROFILE $RepoName
    Say-Step "Locating repo"
    if (Test-Path (Join-Path $RepoRoot '.git')) {
        Say-Ok "Existing checkout at $RepoRoot -- updating"
        Push-Location $RepoRoot
        try {
            git pull --ff-only
            Say-Ok "Repo up to date"
        } catch {
            Say-Warn "git pull failed - continuing with current checkout."
        }
        Pop-Location
    } else {
        if ($Failures -gt 0) {
            Say-Warn "Skipping clone - fix the issues above first, then re-run this script."
        } else {
            Say-Info "Cloning $RepoUrl into $RepoRoot"
            try {
                git clone $RepoUrl $RepoRoot
                Say-Ok "Cloned to $RepoRoot"
            } catch {
                Say-Fail "git clone failed. Check your internet connection and that the repo is accessible."
                Note-Failure
            }
        }
    }
}

# ----------------------------------------------------------------------
# 8. npm install
# ----------------------------------------------------------------------
if ($Failures -eq 0 -and (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    Say-Step "Running npm install (this takes a few minutes)"
    Push-Location $RepoRoot
    try {
        npm install --no-audit --no-fund
        Say-Ok "npm install complete"
    } catch {
        Say-Fail "npm install failed. See output above."
        Note-Failure
    } finally {
        Pop-Location
    }
}

# ----------------------------------------------------------------------
# 9. Sanity-check critical binaries
# ----------------------------------------------------------------------
if ($Failures -eq 0) {
    Say-Step "Verifying critical dependencies"
    $openclawBin = Join-Path $RepoRoot 'node_modules\.bin\openclaw.cmd'
    $openclawAlt = Join-Path $RepoRoot 'node_modules\.bin\openclaw'
    if ((Test-Path $openclawBin) -or (Test-Path $openclawAlt)) {
        Say-Ok "openclaw binary present"
    } else {
        Say-Fail "openclaw binary not found in node_modules - npm install may be incomplete."
        Note-Failure
    }
    $bsq = Join-Path $RepoRoot 'node_modules\better-sqlite3'
    if (Test-Path $bsq) {
        Say-Ok "better-sqlite3 native module present"
    } else {
        Say-Fail "better-sqlite3 not found - npm install may be incomplete."
        Note-Failure
    }
}

# ----------------------------------------------------------------------
# 10. Port check (informational)
# ----------------------------------------------------------------------
Say-Step "Checking default gateway port 18789"
$portInUse = $false
try {
    $portInUse = [bool](Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue)
} catch { $portInUse = $false }
if ($portInUse) {
    Say-Warn "Port 18789 is in use - the app will auto-pick the next free port on launch."
} else {
    Say-Ok "Port 18789 free"
}

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
Write-Host ''
if ($Failures -eq 0) {
    Write-Host "You're set." -ForegroundColor Green
    Write-Host ''
    Write-Host "Start the app with:" -ForegroundColor White
    Write-Host "  cd `"$RepoRoot`""
    Write-Host "  npm start"
    Write-Host ''
    Write-Host "On first launch you'll walk through naming your agent and setting your values."
    Write-Host "If anything breaks, paste the error output back to Chris."
} else {
    Write-Host "$Failures item(s) need attention." -ForegroundColor Red
    Write-Host "Fix the issues flagged above, then re-run this script."
    exit 1
}
