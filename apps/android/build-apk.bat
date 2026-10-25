@echo off
setlocal EnableExtensions DisableDelayedExpansion
title ATLAS - build Android APK
rem ===========================================================================
rem  Builds one signed APK for Android phones, tablets, Android TV and Fire TV.
rem
rem    build-apk.bat                                   asks for the server on first launch
rem    build-apk.bat https://your-atlas.onrender.com   bakes your server address in
rem
rem  Output: dist\ATLAS.apk in the project folder.
rem  The release signing key is created once in apps\android\keystore (never commit it,
rem  and back it up: updates must be signed with the same key).
rem ===========================================================================
cd /d "%~dp0"
set "TOOLS=%USERPROFILE%\.tools"
if not defined JAVA_HOME set "JAVA_HOME=%TOOLS%\jdk17"
if not defined ANDROID_HOME set "ANDROID_HOME=%TOOLS%\android-sdk"
set "PATH=%JAVA_HOME%\bin;%PATH%"

if not exist "%JAVA_HOME%\bin\java.exe" (
  echo [X] Java 17 not found in %JAVA_HOME%. Set JAVA_HOME to a JDK 17 install.
  goto :fail
)
if not exist "%ANDROID_HOME%\platforms\android-35" (
  echo [X] Android SDK platform 35 not found in %ANDROID_HOME%. Set ANDROID_HOME.
  goto :fail
)
echo [ok] Java and Android SDK found

rem  Gradle reads the SDK location from local.properties: forward slashes, colon escaped.
set "SDK_ESC=%ANDROID_HOME:\=/%"
set "SDK_ESC=%SDK_ESC::=\:%"
> local.properties echo sdk.dir=%SDK_ESC%

if exist "keystore.properties" goto :build
echo [..] Creating the release signing key (first build only)
if not exist "keystore" mkdir "keystore"
set "KS_PASS=atlas-%RANDOM%%RANDOM%-%RANDOM%%RANDOM%-%RANDOM%%RANDOM%"
keytool -genkeypair -keystore "keystore\atlas-release.jks" -storetype PKCS12 -alias atlas -keyalg RSA -keysize 2048 -validity 10000 -storepass "%KS_PASS%" -keypass "%KS_PASS%" -dname "CN=ATLAS" >nul
if errorlevel 1 goto :fail
> keystore.properties echo storeFile=keystore/atlas-release.jks
>> keystore.properties echo storePassword=%KS_PASS%
>> keystore.properties echo keyAlias=atlas
>> keystore.properties echo keyPassword=%KS_PASS%
echo [ok] Signing key created in apps\android\keystore - back it up

:build
set "SERVER_ARG="
if not "%~1"=="" set "SERVER_ARG=-PatlasServer=%~1"
echo [..] Building (the first build downloads Gradle and libraries)
call "%~dp0gradlew.bat" assembleRelease %SERVER_ARG% --no-daemon --console=plain
if errorlevel 1 (
  echo [X] The Android build failed.
  goto :fail
)
if not exist "..\..\dist" mkdir "..\..\dist"
copy /y "app\build\outputs\apk\release\app-release.apk" "..\..\dist\ATLAS.apk" >nul
if errorlevel 1 goto :fail
echo.
echo [ok] APK ready: %~dp0..\..\dist\ATLAS.apk
echo      Install on a phone: copy it over and open it (allow "Install unknown apps").
echo      Install on Fire TV / Android TV: see docs\ANDROID.md (Downloader app or adb).
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
