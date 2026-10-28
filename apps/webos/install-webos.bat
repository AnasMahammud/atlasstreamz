@echo off
setlocal EnableExtensions DisableDelayedExpansion
title ATLAS - install on LG TV
rem ===========================================================================
rem  Installs dist\ATLAS.ipk on an LG TV in Developer Mode and opens it.
rem
rem    install-webos.bat                 asks for the TV's IP address
rem    install-webos.bat 192.168.1.50    uses this address
rem
rem  On the TV, open the Developer Mode app first: Dev Mode Status and Key Server must
rem  both be ON. It shows the TV's IP address and the Passphrase this asks for.
rem ===========================================================================
cd /d "%~dp0"
set "NODE_DIR=%USERPROFILE%\.tools\node-v22.23.4-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js not found. Expected the portable install in %NODE_DIR%
  goto :fail
)
set "TV=%~1"
if "%TV%"=="" set /p "TV=TV IP address (Developer Mode app, Device IP): "
node "%~dp0..\..\scripts\webos.mjs" install "%TV%"
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo   Install stopped. Check the TV is on, in Developer Mode with Key Server ON,
echo   and on the same network as this PC.
endlocal
if not defined ATLAS_NO_PAUSE pause
exit /b 1

:end
endlocal
if not defined ATLAS_NO_PAUSE pause
exit /b 0
