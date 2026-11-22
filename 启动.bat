@echo off
chcp 936 >nul
title HMCS Manager - Minecraft 服务端管理器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 没有检测到 Node.js。
  echo       请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo       安装完成后重新双击本文件。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\js-yaml" (
  echo [1/2] 首次运行，正在安装依赖 ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [!] 依赖安装失败，请检查网络或代理设置。
    pause
    exit /b 1
  )
)

echo [2/2] 正在启动 HMCS Manager，浏览器稍后自动打开 ...
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; if (Test-Path 'last-url.txt') { $u=(Get-Content -Raw 'last-url.txt').Trim(); if ($u) { Start-Process $u } }"
node app.js

echo.
echo HMCS Manager 已退出。
pause
