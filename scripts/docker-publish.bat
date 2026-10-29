@echo off
rem Push the image built by scripts\docker-build.bat. This script never builds: what you confirm here is
rem exactly what you tested locally.
rem
rem Usage:
rem   scripts\docker-publish.bat              push package.json's version and latest
rem   scripts\docker-publish.bat 0.1.0        push that version instead (its tag must exist locally)
rem
rem Destination repository must match the one you built with:
rem   set IMAGE_REPO=myuser/myimage
rem Credentials are Docker's own: run `docker login` first. Nothing here stores, reads or asks for a password.
rem
rem Why it is guarded: a pushed layer is permanent once it leaves your machine. That is the whole reason the
rem real config/opencode.json (plaintext apiKey) and config/.keys stay out of the image, and .dockerignore
rem excludes them absolutely (AGENTS.md section 5). latest must also come from the same build as the version
rem tag - a latest pointing somewhere else is the stale-image bug that wastes an afternoon.

setlocal
cd /d "%~dp0.."

if not defined IMAGE_REPO set "IMAGE_REPO=bruce1977/opencode-port"

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "APP_VERSION=%%v"
if not "%~1"=="" set "APP_VERSION=%~1"
if "%APP_VERSION%"=="" (
  echo [publish] failed: cannot determine the version
  exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
  echo [publish] failed: docker is not in PATH
  exit /b 1
)

rem Both tags must resolve locally, and to the very same image id.
for /f "usebackq delims=" %%i in (`docker image inspect %IMAGE_REPO%:%APP_VERSION% --format "{{.Id}}" 2^>nul`) do set "ID_VERSION=%%i"
for /f "usebackq delims=" %%i in (`docker image inspect %IMAGE_REPO%:latest --format "{{.Id}}" 2^>nul`) do set "ID_LATEST=%%i"
if "%ID_VERSION%"=="" (
  echo [publish] failed: %IMAGE_REPO%:%APP_VERSION% is not in the local image list. Run scripts\docker-build.bat first.
  exit /b 1
)
if "%ID_LATEST%"=="" (
  echo [publish] failed: %IMAGE_REPO%:latest is not in the local image list. Run scripts\docker-build.bat first.
  exit /b 1
)
if "%ID_VERSION%" neq "%ID_LATEST%" (
  echo [publish] failed: %IMAGE_REPO%:%APP_VERSION% and :latest are different images.
  echo [publish]         version=%ID_VERSION%
  echo [publish]         latest =%ID_LATEST%
  echo [publish]         Rebuild with scripts\docker-build.bat so both tags point at one build, then publish again.
  exit /b 1
)

echo [publish] repository : %IMAGE_REPO%
echo [publish] image id   : %ID_VERSION%
docker image inspect %IMAGE_REPO%:%APP_VERSION% --format "[publish] built at : {{.Created}}"
echo [publish] tags       : %APP_VERSION% latest
echo.
echo [publish] Once pushed, these layers are public: deleting a tag does not take them back.

set "CONFIRM="
set /p CONFIRM=[publish] type %IMAGE_REPO% to push: 
if not "%CONFIRM%"=="%IMAGE_REPO%" (
  echo [publish] cancelled: nothing was pushed
  exit /b 1
)

echo [publish] pushing %IMAGE_REPO%:%APP_VERSION%
docker push %IMAGE_REPO%:%APP_VERSION%
if errorlevel 1 (
  echo [publish] failed: are you logged in? run `docker login` and retry.
  exit /b 1
)

echo [publish] pushing %IMAGE_REPO%:latest
docker push %IMAGE_REPO%:latest
if errorlevel 1 (
  echo [publish] partial: %IMAGE_REPO%:%APP_VERSION% is on the registry, latest was not updated.
  echo [publish] retry this script - it is idempotent for the tag that already succeeded.
  exit /b 1
)

docker image inspect %IMAGE_REPO%:%APP_VERSION% --format "[publish] remote digests for this local image: {{range .RepoDigests}}{{.}} {{end}}"
echo [publish] ok: %IMAGE_REPO%:%APP_VERSION% and :latest both point at %ID_VERSION%
exit /b 0
