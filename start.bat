@echo off
rem ============================================================
rem  HMCS Manager - Windows launcher (ASCII version)
rem  Use this if the Chinese filename / GBK console looks broken.
rem ============================================================
title HMCS Manager
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js not found.
  echo       Install Node.js 18 or newer from https://nodejs.org/
  echo       then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\js-yaml" (
  echo [1/2] Installing dependencies ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [!] npm install failed. Check your network / proxy.
    pause
    exit /b 1
  )
)

echo [2/2] Starting HMCS Manager, browser will open shortly ...
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; if (Test-Path 'last-url.txt') { $u=(Get-Content -Raw 'last-url.txt').Trim(); if ($u) { Start-Process $u } }"
node app.js

echo.
echo HMCS Manager has exited.
pause
