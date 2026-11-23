@echo off
rem ---------------------------------------------------------------------------
rem  HMCS service manager launcher (Windows)
rem  All Chinese text is printed by scripts\service.js under codepage 65001,
rem  so this file itself stays pure ASCII and never gets garbled.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem --- request administrator rights (SCHTASKS /RU SYSTEM needs elevation) ---
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator privileges...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js 18+ not found in PATH.
  echo   Download: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "scripts\service.js" %*
set "RC=%ERRORLEVEL%"

if "%~1"=="" pause
endlocal & exit /b %RC%
