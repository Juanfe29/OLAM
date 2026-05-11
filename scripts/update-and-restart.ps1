# OLAM Plataforma — Actualizar Código y Reiniciar
# Ejecutar como: powershell -ExecutionPolicy Bypass -File update-and-restart.ps1

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "OLAM Update & Restart — 172.18.164.35" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- Git pull ---
Write-Host "[1/4] Actualizando código desde git..." -ForegroundColor Yellow

cd $projectRoot

Write-Host "  Rama actual:" -ForegroundColor Cyan
git branch --show-current

Write-Host "  Último commit:" -ForegroundColor Cyan
git log --oneline -1

Write-Host "  Pulling cambios..." -ForegroundColor Cyan
git pull origin main
Write-Host "  ✓ Git pull OK" -ForegroundColor Green

# --- Backend update ---
Write-Host ""
Write-Host "[2/4] Actualizando Backend..." -ForegroundColor Yellow

$backendPath = "$projectRoot\backend"
cd $backendPath

Write-Host "  npm install..." -ForegroundColor Cyan
npm install --omit=dev
Write-Host "  ✓ Backend updated" -ForegroundColor Green

# --- Frontend update ---
Write-Host ""
Write-Host "[3/4] Actualizando Frontend..." -ForegroundColor Yellow

$frontendPath = "$projectRoot\frontend"
cd $frontendPath

Write-Host "  npm install..." -ForegroundColor Cyan
npm install --omit=dev
Write-Host "  ✓ Frontend updated" -ForegroundColor Green

# --- Reiniciar servicios ---
Write-Host ""
Write-Host "[4/4] Reiniciando servicios..." -ForegroundColor Yellow

Write-Host "  Matando procesos node anteriores..." -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Write-Host "  ✓ Procesos node detenidos" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "ACTUALIZACIÓN COMPLETADA" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "En terminal 1 — Backend:"
Write-Host "  cd $backendPath"
Write-Host "  npm run dev"
Write-Host ""
Write-Host "En terminal 2 — Frontend:"
Write-Host "  cd $frontendPath"
Write-Host "  npm run dev"
Write-Host ""
Write-Host "Dashboard: http://localhost:5173"
Write-Host ""
