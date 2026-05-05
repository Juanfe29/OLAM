# OLAM Plataforma — Setup Inicial en 172.18.164.35
# Ejecutar como: powershell -ExecutionPolicy Bypass -File setup-initial.ps1

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "OLAM Setup Inicial — 172.18.164.35" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- Verificar requisitos ---
Write-Host "[1/5] Verificando requisitos..." -ForegroundColor Yellow

$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "ERROR: Node.js no está instalado" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Node.js $nodeVersion" -ForegroundColor Green

$npmVersion = npm --version 2>$null
if (-not $npmVersion) {
    Write-Host "ERROR: npm no está instalado" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ npm $npmVersion" -ForegroundColor Green

$gitVersion = git --version 2>$null
if (-not $gitVersion) {
    Write-Host "ERROR: git no está instalado" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ $gitVersion" -ForegroundColor Green

# --- Backend setup ---
Write-Host ""
Write-Host "[2/5] Setup Backend..." -ForegroundColor Yellow

$backendPath = "$projectRoot\backend"
if (-not (Test-Path $backendPath)) {
    Write-Host "ERROR: Backend path no existe: $backendPath" -ForegroundColor Red
    exit 1
}

cd $backendPath

# Copiar .env.example a .env si no existe
if (-not (Test-Path ".env")) {
    Write-Host "  Creando .env desde .env.example..." -ForegroundColor Cyan
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "  ✓ .env creado" -ForegroundColor Green
    } else {
        Write-Host "  ⚠ .env.example no encontrado — manual setup required" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ✓ .env ya existe" -ForegroundColor Green
}

# npm install
Write-Host "  Instalando dependencias backend..." -ForegroundColor Cyan
npm install --omit=dev
Write-Host "  ✓ Backend dependencies OK" -ForegroundColor Green

# --- Frontend setup ---
Write-Host ""
Write-Host "[3/5] Setup Frontend..." -ForegroundColor Yellow

$frontendPath = "$projectRoot\frontend"
if (-not (Test-Path $frontendPath)) {
    Write-Host "ERROR: Frontend path no existe: $frontendPath" -ForegroundColor Red
    exit 1
}

cd $frontendPath

Write-Host "  Instalando dependencias frontend..." -ForegroundColor Cyan
npm install --omit=dev
Write-Host "  ✓ Frontend dependencies OK" -ForegroundColor Green

# --- Verificar .env backend ---
Write-Host ""
Write-Host "[4/5] Verificando configuración..." -ForegroundColor Yellow

$envFile = "$backendPath\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "  ⚠ Backend .env no existe" -ForegroundColor Yellow
    Write-Host "  Debes crear manualmente:" -ForegroundColor Yellow
    Write-Host "    SSH_HOST=172.18.164.33" -ForegroundColor Cyan
    Write-Host "    SSH_USER=root" -ForegroundColor Cyan
    Write-Host "    SSH_PASSWORD=Olam2026$" -ForegroundColor Cyan
} else {
    Write-Host "  ✓ .env existe" -ForegroundColor Green
    $sshHost = Select-String "SSH_HOST" $envFile | Select-Object -First 1
    if ($sshHost) {
        Write-Host "    $sshHost" -ForegroundColor Cyan
    }
}

# --- Listo ---
Write-Host ""
Write-Host "[5/5] Setup completado" -ForegroundColor Yellow
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "PRÓXIMOS PASOS:" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "1. Verificar backend/.env está correctamente configurado:"
Write-Host "   SSH_HOST=172.18.164.33"
Write-Host "   SSH_USER=root"
Write-Host "   SSH_PASSWORD=Olam2026$"
Write-Host ""
Write-Host "2. En terminal 1 — Backend:"
Write-Host "   cd $backendPath"
Write-Host "   npm run dev"
Write-Host ""
Write-Host "3. En terminal 2 — Frontend:"
Write-Host "   cd $frontendPath"
Write-Host "   npm run dev"
Write-Host ""
Write-Host "4. Abrir navegador:"
Write-Host "   http://localhost:5173"
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
