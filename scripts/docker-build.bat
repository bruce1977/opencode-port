@echo off
rem Build the gateway image. Versions come from package.json, so neither this script nor the Dockerfile
rem holds a second source of truth for APP_VERSION or for the OpenCode CLI/client pin (AGENTS.md section 6).
rem
rem Usage:
rem   scripts\docker-build.bat              run npm run check, then build
rem   scripts\docker-build.bat --no-check   skip the lint+test gate, everything else unchanged
rem
rem Destination repository (also read by scripts\docker-publish.bat), override without editing this file:
rem   set IMAGE_REPO=myuser/myimage
rem
rem Expect one BuildKit warning: SecretsUsedInArgOrEnv, triggered by the *names* of the image ENVs
rem API_KEY_ENABLED / API_KEYS_FILE. It is a switch and a path, not credentials - docs/docker-deployment.md 5.2.
rem
rem This script writes the version tag AND latest from the same build, which is what keeps latest from
rem going stale relative to the last thing you actually tested.

setlocal
cd /d "%~dp0.."

if not defined IMAGE_REPO set "IMAGE_REPO=bruce1977/opencode-port"

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "APP_VERSION=%%v"
for /f "usebackq delims=" %%c in (`node -p "require('./package.json').dependencies['@opencode/client']"`) do set "CLI_VERSION=%%c"
if "%APP_VERSION%"=="" (
  echo [build] failed: cannot read version from package.json
  exit /b 1
)
if "%CLI_VERSION%"=="" (
  echo [build] failed: cannot read dependencies "@opencode/client" from package.json
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [build] failed: node is not in PATH
  exit /b 1
)
where docker >nul 2>&1
if errorlevel 1 (
  echo [build] failed: docker is not in PATH
  exit /b 1
)

if /i "%~1"=="--no-check" (
  echo [build] lint and test gate: SKIPPED
) else (
  echo [build] lint and test gate: npm run check
  call npm run check
  if errorlevel 1 (
    echo [build] failed: npm run check is not green, nothing was built
    exit /b 1
  )
)

echo [build] APP_VERSION=%APP_VERSION%  OPENCODE_CLI_VERSION=%CLI_VERSION%  (from package.json)
echo [build] docker build -t %IMAGE_REPO%:%APP_VERSION% -t %IMAGE_REPO%:latest
docker build ^
  --build-arg APP_VERSION=%APP_VERSION% ^
  --build-arg OPENCODE_CLI_VERSION=%CLI_VERSION% ^
  -t %IMAGE_REPO%:%APP_VERSION% ^
  -t %IMAGE_REPO%:latest ^
  .
if errorlevel 1 (
  echo [build] failed: docker build exited non-zero
  exit /b 1
)

docker image inspect %IMAGE_REPO%:%APP_VERSION% --format "[build] created={{.Created}} size={{.Size}} id={{.Id}}"

echo.
echo [build] ok. The image already carries config.yaml + opencode.json, so no volume is needed to boot it:
echo [build]   docker run -d --name opencode-gateway -e OPENCODE_SERVER_PASSWORD=change-me -p 10000:8000 %IMAGE_REPO%:%APP_VERSION%
echo [build]   curl http://127.0.0.1:10000/health
echo [build]   curl http://127.0.0.1:10000/v1/models
echo [build] Push it only after you have looked at it:  scripts\docker-publish.bat
exit /b 0
