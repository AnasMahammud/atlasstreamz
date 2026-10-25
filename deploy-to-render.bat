@echo off
setlocal EnableExtensions DisableDelayedExpansion
title ATLAS - GitHub and Render setup

rem ===========================================================================
rem  ATLAS: put the website online in one go.
rem    1. checks no secrets can be published, runs the tests and builds
rem    2. creates a PRIVATE GitHub repository (browser sign-in) and uploads everything
rem    3. creates the Render web service, waits until it is live and opens your website
rem
rem    deploy-to-render.bat             full run
rem    deploy-to-render.bat --check     only verify prerequisites, secrets, tests and build
rem    deploy-to-render.bat --dry-run   also show the GitHub/Render steps without doing them
rem
rem  Re-run it any time to publish updates: Render redeploys on every push.
rem ===========================================================================

cd /d "%~dp0"
set "MODE=%~1"
set "NODE_DIR=%USERPROFILE%\.tools\node-v22.23.4-win-x64"

echo.
echo   ATLAS  -  Your Universe of Entertainment
echo   GitHub + Render deployment
echo   ------------------------------------------------------------
echo.

rem ---------------------------------------------------------------- 1. Tools
where git >nul 2>&1
if errorlevel 1 (
  echo [X] Git is not installed. Install Git for Windows from https://git-scm.com/download/win
  goto :fail
)
echo [ok] Git found

if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js not found. Expected the portable install in %NODE_DIR%
  goto :fail
)
echo [ok] Node.js found

rem ---------------------------------------------------------------- 2. Repository
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [..] Creating a local Git repository
  git init -q
  if errorlevel 1 goto :fail
)
echo [ok] Git repository ready

rem ---------------------------------------------------------------- 3. Secrets stay local
rem  .env.local holds your provider URL; data\ holds the database and encryption key.
if exist ".env.local" (
  git check-ignore -q ".env.local"
  if errorlevel 1 (
    echo [X] .env.local is NOT ignored by Git. Refusing to continue so your provider login stays private.
    goto :fail
  )
)
if exist "data" (
  git check-ignore -q "data"
  if errorlevel 1 (
    echo [X] The data folder is NOT ignored by Git. Refusing to continue.
    goto :fail
  )
)
rem  Look for a real-looking provider login (user and password of 6+ chars) in any file Git would publish.
git grep -q -I --untracked -E "username=[A-Za-z0-9]{6,}&password=[A-Za-z0-9]{6,}" -- . ":(exclude)deploy-to-render.bat"
rem  git grep: 0 = found, 1 = clean, 2+ = error. An error must stop us, never count as clean.
if errorlevel 2 (
  echo [X] Could not scan the project for credentials. Stopping to be safe.
  goto :fail
)
if not errorlevel 1 (
  echo [X] A provider username/password was found in a file that would be published:
  git grep -l -I --untracked -E "username=[A-Za-z0-9]{6,}&password=[A-Za-z0-9]{6,}" -- . ":(exclude)deploy-to-render.bat"
  echo     Move it into .env.local, which is never uploaded, then run this again.
  goto :fail
)
echo [ok] No provider credentials in files that would be published

rem ---------------------------------------------------------------- 4. Tests and build
if not exist "node_modules" (
  echo [..] Installing dependencies
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)
echo [..] Running tests
call npm test --silent
if errorlevel 1 (
  echo [X] Tests failed. Fix them before publishing.
  goto :fail
)
echo [ok] Tests passed
echo [..] Building the web app
call npm run build --silent
if errorlevel 1 (
  echo [X] The production build failed.
  goto :fail
)
echo [ok] Production build succeeded

if /i "%MODE%"=="--check" (
  echo.
  echo   Check complete. Nothing was committed or pushed.
  goto :end
)

rem ---------------------------------------------------------------- 5. Git identity
for /f "delims=" %%N in ('git config user.name 2^>nul') do set "GIT_NAME=%%N"
if not defined GIT_NAME (
  set /p "GIT_NAME=Your name for Git commits: "
  call git config user.name "%%GIT_NAME%%"
)
for /f "delims=" %%E in ('git config user.email 2^>nul') do set "GIT_EMAIL=%%E"
if not defined GIT_EMAIL (
  set /p "GIT_EMAIL=Your email for Git commits: "
  call git config user.email "%%GIT_EMAIL%%"
)

rem ---------------------------------------------------------------- 6. GitHub + Render
rem  Commits, creates the private GitHub repository (browser sign-in), uploads everything,
rem  creates the Render web service and waits until the website is live.
node "%~dp0scripts\deploy.mjs" %MODE%
if errorlevel 1 goto :fail
goto :end

:fail
)
echo [ok] Git found

if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js not found. Expected the portable install in %NODE_DIR%
  goto :fail
)
echo [ok] Node.js found

rem ---------------------------------------------------------------- 2. Repository
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [..] Creating a local Git repository
  git init -q
  if errorlevel 1 goto :fail
)
echo [ok] Git repository ready

rem ---------------------------------------------------------------- 3. Secrets stay local
rem  .env.local holds your provider URL; data\ holds the database and encryption key.
if exist ".env.local" (
  git check-ignore -q ".env.local"
  if errorlevel 1 (
    echo [X] .env.local is NOT ignored by Git. Refusing to continue so your provider login stays private.
    goto :fail
  )
)
if exist "data" (
  git check-ignore -q "data"
  if errorlevel 1 (
    echo [X] The data folder is NOT ignored by Git. Refusing to continue.
    goto :fail
  )
)
rem  Look for a real-looking provider login (user and password of 6+ chars) in any file Git would publish.
git grep -q -I --untracked -E "username=[A-Za-z0-9]{6,}&password=[A-Za-z0-9]{6,}" -- . ":(exclude)deploy-to-render.bat"
rem  git grep: 0 = found, 1 = clean, 2+ = error. An error must stop us, never count as clean.
if errorlevel 2 (
  echo [X] Could not scan the project for credentials. Stopping to be safe.
  goto :fail
)
if not errorlevel 1 (
  echo [X] A provider username/password was found in a file that would be published:
  git grep -l -I --untracked -E "username=[A-Za-z0-9]{6,}&password=[A-Za-z0-9]{6,}" -- . ":(exclude)deploy-to-render.bat"
  echo     Move it into .env.local, which is never uploaded, then run this again.
  goto :fail
)
echo [ok] No provider credentials in files that would be published

rem ---------------------------------------------------------------- 4. Tests and build
if not exist "node_modules" (
  echo [..] Installing dependencies
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)
echo [..] Running tests
call npm test --silent
if errorlevel 1 (
  echo [X] Tests failed. Fix them before publishing.
  goto :fail
)
echo [ok] Tests passed
echo [..] Building the web app
call npm run build --silent
if errorlevel 1 (
  echo [X] The production build failed.
  goto :fail
)
echo [ok] Production build succeeded

if /i "%MODE%"=="--check" (
  echo.
  echo   Check complete. Nothing was committed or pushed.
  goto :end
)

rem ---------------------------------------------------------------- 5. Commit
for /f "delims=" %%N in ('git config user.name 2^>nul') do set "GIT_NAME=%%N"
if not defined GIT_NAME (
  set /p "GIT_NAME=Your name for Git commits: "
  call git config user.name "%%GIT_NAME%%"
)
for /f "delims=" %%E in ('git config user.email 2^>nul') do set "GIT_EMAIL=%%E"
if not defined GIT_EMAIL (
  set /p "GIT_EMAIL=Your email for Git commits: "
  call git config user.email "%%GIT_EMAIL%%"
)

git add -A
if errorlevel 1 goto :fail
rem  Final guard on exactly what is staged.
git diff --cached --name-only | findstr /i /r /c:"^\.env\.local$" /c:"^data/" /c:"\.sqlite" /c:"secret\.key" /c:"keystore" /c:"\.jks$" /c:"\.apk$" >nul
if not errorlevel 1 (
  echo [X] Secret files are staged. Unstaging everything and stopping.
  git reset -q
  goto :fail
)
git diff --cached --quiet
if errorlevel 1 (
  git commit -q -m "ATLAS update"
  if errorlevel 1 goto :fail
  echo [ok] Changes committed
) else (
  echo [ok] Nothing new to commit
)
git branch -M main

rem ---------------------------------------------------------------- 6. GitHub
git remote get-url origin >nul 2>&1
if not errorlevel 1 goto :push

where gh >nul 2>&1
if errorlevel 1 goto :manual_repo
gh auth status >nul 2>&1
if errorlevel 1 (
  echo [..] Signing in to GitHub CLI
  gh auth login --web
  if errorlevel 1 goto :manual_repo
)
set "REPO_NAME=atlas"
set /p "REPO_NAME=GitHub repository name [atlas]: "
echo [..] Creating private repository %REPO_NAME%
gh repo create "%REPO_NAME%" --private --source . --remote origin --push
if errorlevel 1 goto :fail
goto :pushed

:manual_repo
echo.
echo   Create an EMPTY PRIVATE repository on GitHub:
echo     1. A browser tab is opening at github.com/new
echo     2. Name it, for example: atlas
echo     3. Choose PRIVATE. Do NOT add a README, .gitignore or licence.
echo     4. Click "Create repository" and copy its HTTPS address,
echo        for example https://github.com/your-name/atlas.git
echo.
start "" "https://github.com/new"
:ask_url
set "REPO_URL="
set /p "REPO_URL=Paste the repository address here: "
if not defined REPO_URL goto :ask_url
echo %REPO_URL%| findstr /i /b /c:"https://github.com/" /c:"git@github.com:" >nul
if errorlevel 1 (
  echo     That doesn't look like a GitHub address. Try again.
  goto :ask_url
)
git remote add origin "%REPO_URL%"
if errorlevel 1 goto :fail

:push
echo [..] Pushing to GitHub. A GitHub sign-in window may open the first time.
git push -u origin main
if errorlevel 1 (
  echo [X] Push failed. Check you have access to the repository and that it was created empty.
  goto :fail
)

:pushed
for /f "delims=" %%U in ('git remote get-url origin') do set "ORIGIN=%%U"
echo [ok] Code is on GitHub: %ORIGIN%

rem ---------------------------------------------------------------- 7. Render
echo.
echo   ------------------------------------------------------------
echo   Next, in Render (a browser tab is opening):
echo     1. Sign in, then connect GitHub and allow access to this repository.
echo     2. New ^> Blueprint ^> pick the repository. Render reads render.yaml.
echo     3. When asked for ATLAS_INITIAL_M3U_URL, paste your playlist link
echo        (the line from .env.local after the = sign). It stays a secret in Render.
echo     4. Approve. The first build takes a few minutes.
echo     5. Open the service URL. On the setup screen enter the setup code:
echo        Render dashboard ^> atlas ^> Environment ^> ATLAS_SETUP_TOKEN
echo     6. Create your owner password, then allow the provider's HTTP connection.
echo.
echo   Every later run of this file publishes your changes and Render redeploys.
echo   ------------------------------------------------------------
start "" "https://dashboard.render.com/blueprints"
goto :end

:fail
echo.
echo   Stopped. Nothing further was published.
endlocal
pause
exit /b 1

:end
echo.
endlocal
pause
exit /b 0
