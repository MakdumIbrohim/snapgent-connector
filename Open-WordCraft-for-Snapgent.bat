@echo off
setlocal
echo.
echo   Preparing WordCraft for Snapgent...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-wordcraft.ps1"
if %ERRORLEVEL% EQU 0 (
  echo.
  echo   WordCraft setup finished. Review the messages above for its connection status.
  echo   Run start.bat to start or restart the bridge and connect to WordCraft.
  echo.
  pause
  exit /b 0
)

echo.
echo   WordCraft setup failed. Review the error above, then try again.
echo.
pause
exit /b %ERRORLEVEL%
