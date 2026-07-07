@echo off
REM aioffice-hwp local preview launcher (Windows 10+)
REM Place this next to a .hwp/.hwpx file and double-click. Or pass a file path.
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "FILE=%~1"
if "%FILE%"=="" (
  for /f "delims=" %%f in ('dir /b /od /a-d *.hwp *.hwpx 2^>nul') do set "FILE=%%f"
)
if "%FILE%"=="" (
  echo No .hwp/.hwpx file found next to this script.
  echo Drop one in the same folder, or pass a path as argument.
  pause
  exit /b 1
)
for %%I in ("%FILE%") do set "FILE_ABS=%%~fI"
if not exist "%FILE_ABS%" (
  echo File not found: %FILE_ABS%
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ required. Install from https://nodejs.org/
  pause
  exit /b 1
)

set "SERVER="
if exist "%USERPROFILE%\.claude\plugins\cache" (
  for /f "delims=" %%s in ('where /r "%USERPROFILE%\.claude\plugins\cache" preview-server.js 2^>nul ^| findstr /i "aioffice-hwp\\.*\\skills\\hwp\\scripts\\preview-server.js"') do set "SERVER=%%s"
)

if "%SERVER%"=="" (
  set "CACHE=%USERPROFILE%\.aioffice-hwp-launcher"
  set "SERVER=!CACHE!\scripts\preview-server.js"
  if not exist "!SERVER!" (
    echo Downloading preview server ^(~5MB^) from GitHub...
    if not exist "!CACHE!" mkdir "!CACHE!"
    curl -fsSL https://codeload.github.com/aidenlim-dev/AIOFFICE-HWP/tar.gz/main -o "!CACHE!\src.tar.gz"
    if errorlevel 1 (
      echo Download failed.
      pause
      exit /b 1
    )
    tar -xzf "!CACHE!\src.tar.gz" -C "!CACHE!" --strip-components=5 AIOFFICE-HWP-main/plugins/aioffice-hwp/skills/aioffice-hwp/scripts
    if errorlevel 1 (
      echo Extract failed. Windows 10 1803+ required for tar support.
      pause
      exit /b 1
    )
    del "!CACHE!\src.tar.gz" >nul 2>nul
  )
)

curl -fsS -o nul http://127.0.0.1:3737/__heartbeat 2>nul
if errorlevel 1 (
  echo Starting preview server...
  start "aioffice-hwp-preview" /b cmd /c "node "!SERVER!" > "%TEMP%\aioffice-hwp-preview.log" 2>&1"
  for /l %%i in (1,1,8) do (
    timeout /t 1 /nobreak >nul
    curl -fsS -o nul http://127.0.0.1:3737/__heartbeat 2>nul
    if not errorlevel 1 goto :ready
  )
)
:ready

powershell -NoProfile -Command "Start-Process ('http://localhost:3737/?path=' + [uri]::EscapeDataString('%FILE_ABS%'))"
echo Opened preview for: %FILE_ABS%
