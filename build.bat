@echo off
title Build
echo Building...
echo.

where node >nul 2>&1
if errorlevel 1 (echo Node.js not found & pause & exit /b 1)

if exist frontend\package-lock.json (
  call npm --prefix frontend ci
) else (
  call npm --prefix frontend install
)
if errorlevel 1 (echo Frontend dependency install failed & pause & exit /b 1)

if exist dist rmdir /s /q dist

call npm run build
if errorlevel 1 (echo Build failed & pause & exit /b 1)

echo.
echo Done. Output in dist\
pause
