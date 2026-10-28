@echo off
setlocal EnableExtensions DisableDelayedExpansion
title ATLAS - build LG webOS app
rem ===========================================================================
rem  Builds the ATLAS app for LG webOS TVs (webOS 5 / 2020 models and newer).
rem
rem    build-webos.bat                                   opens your Render site from the last deploy
rem    build-webos.bat https://your-atlas.onrender.com   opens this server instead
rem
rem  Output: dist\ATLAS.ipk in the project folder.
rem  Then put the TV in Developer Mode and run install-webos.bat (see docs\WEBOS.md).
rem ===========================================================================
cd /d "%~dp0"
set "NODE_DIR=%USERPROFILE%\.tools\node-v22.23.4-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js not found. Expected the portable install in %NODE_DIR%
  goto :fail
)
node "%~dp0..\..\scripts\webos.mjs" build %1
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo   Build stopped.
endlocal
if not defined ATLAS_NO_PAUSE pause
exit /b 1

:end
endlocal
if not defined ATLAS_NO_PAUSE pause
exit /b 0
