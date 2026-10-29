# Node 22 LTS (Node 20 is EOL; see engines in package.json)
FROM node:22-slim

# Image metadata. APP_VERSION is passed in by the build command (`--build-arg APP_VERSION=$(node -p ...)`)
# rather than hardcoded here, so package.json stays the only source for the gateway version.
ARG APP_VERSION=dev
ARG OPENCODE_CLI_VERSION=2.2.0
LABEL org.opencontainers.image.title="OpenCode API Gateway" \
      org.opencontainers.image.description="OpenAI/Anthropic-compatible API gateway for OpenCode built-in free models and custom providers" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.url="https://github.com/bruce1977/opencode-port" \
      org.opencontainers.image.source="https://github.com/bruce1977/opencode-port" \
      org.opencontainers.image.licenses="MIT" \
      ai.opencode.gateway.cli-version="${OPENCODE_CLI_VERSION}"

# Version is pinned at build time (not an env var).
# WARNING: must match @opencode/client in package.json (client is generated from the server OpenAPI spec).

# Install the pinned OpenCode CLI (2.x: @opencode/cli, postinstall fetches the platform binary).
# Keep only glibc x64 (plus -baseline for CPUs without AVX2); musl variants are useless on node:22-slim and cost ~460MB.
RUN npm install -g --no-audit --no-fund @opencode/cli@${OPENCODE_CLI_VERSION} \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-linux-x64-musl \
           /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-linux-x64-baseline-musl

WORKDIR /app

# Install dependencies first to reuse the layer cache; npm ci requires the committed package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Runtime payload only — no `COPY . .`. Whatever the process never reads stays out of the image
# (repo docs, tests, dev-only configs, and any stray directory that happened to sit in the build context).
COPY src ./src
# config.yaml is the business-defaults file. config/opencode.json (the provider config `opencode serve` reads
# through OPENCODE_CONFIG_DIR) is baked too, under the destination name: opencode 2.2.0 never creates that file
# (docs/docker-deployment.md §2.1), so without it a fresh container has no custom models at all and "docker run"
# alone would not be a deployment.
# The baked copy comes from the committed TEMPLATE (config/opencode.json.example, keys written as {env:VAR}),
# not from config/opencode.json: the real file is gitignored, machine-specific, and may hold a plaintext apiKey —
# an image layer is permanent once pushed, so it stays excluded by .dockerignore and is copied only as the
# template. That exclusion is not cosmetic: it is what makes "bake opencode.json" safe.
# Runtime override: -v ./config:/app/config:ro replaces the whole directory, so the mounted dir must contain an
# opencode.json of its own (a mount without one hides the baked default). To override one file only, bind-mount
# that file instead of the directory.
COPY config/config.yaml ./config/
COPY config/opencode.json.example ./config/opencode.json
# The key list must exist even when nothing is mounted: an empty file yields an empty key set, so auth
# denies every request and the startup log says so (a missing file would look identical but for the message).
RUN touch /app/config/.keys
# The Docker health check (HEALTHCHECK below) runs this as its own process; it is not part of the gateway.
COPY scripts ./scripts

# ===== deployment defaults =====
# Every value below is a *default*, not a lock: override any of them at run time (`-e`, `--env-file`) without
# rebuilding. That is the supported way to adapt one image to several machines — see docs/docker-deployment.md §4.
#   PORT: the port *inside* the container; the published port is `-p HOST:CONTAINER` and is unrelated to EXPOSE.
#   OPENCODE_SERVER_PASSWORD: the Basic-auth password between the gateway and the `opencode serve` it spawns.
#     That listener is 127.0.0.1 inside the container, so this is not a public credential — but it is a fixed
#     value in an image layer, so **change it** for anything beyond a trusted LAN, and never point
#     OPENCODE_SERVER_URL at a remote instance while this default is still in use.
#   API_KEY_ENABLED: off by default so a fresh container is reachable without a key list. Turning it on with
#     no keys loaded locks every request out (401) and makes the health check report unhealthy.
#   API_KEYS_FILE: the image default already resolves to the mounted ./config directory; passing a *host* path
#     (e.g. D:\...\config\.keys) in here yields an empty key set, which looks identical to a broken gateway.
#   OLLAMA_LOCAL_PROVIDER: the custom provider id; it must equal the `providers` key in config/opencode.json
#     (and the name spelled inside config.yaml's models.allow). See docs/docker-deployment.md §3.
# Not here on purpose: API_KEY / SEARCH_API_KEY and any provider key — those are real secrets, runtime-only
# (`-e NAME` / --env-file), never ARGs or ENVs, so they cannot reach an image layer or `docker history`.
# That includes OLLAMA_API_KEY, which the baked /app/config/opencode.json interpolates: leaving it unset is not
# an error (verified on 2.2.0 — the provider still registers and its models still appear in /v1/models), so the
# image gives no default; set it only when the OpenAI-compatible endpoint actually checks a key.
# The accepted-key list config/.keys is excluded by .dockerignore for the same reason; only an empty file ships.
# Names containing API_KEY trip BuildKit's SecretsUsedInArgOrEnv warning at build time. The warning is expected
# and harmless here (a switch and a path, not credentials) — do not "fix" it by moving the defaults into ARGs.
ENV PORT=8000 \
    OPENCODE_SERVER_PORT=10001 \
    OPENCODE_SERVER_URL="" \
    OPENCODE_SERVER_PASSWORD=88888888 \
    LOG_LEVEL=info \
    CONFIG_PATH=/app/config/config.yaml \
    API_KEY_ENABLED=false \
    API_KEYS_FILE=/app/config/.keys \
    OLLAMA_LOCAL_PROVIDER=ollama-local

# Container-side OpenCode context trimming: isolated config dir, no project/Claude instructions, no skills, no watchers.
# Every name here is verified against the 2.2.0 binary; the 1.x-only OPENCODE_DISABLE_DEFAULT_PLUGINS and
# OPENCODE_DISABLE_LSP_DOWNLOAD were dropped because 2.x ignores them (they looked like working trimming, but did nothing).
ENV OPENCODE_CONFIG_DIR=/app/config \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_FILEWATCHER=true

# Server-side websearch needs a declared provider; a fresh container has no OpenCode state to inherit one from
# (an interactive host run persists `websearch:provider` into its own database). "random" picks any backend
# OpenCode can reach without a user credential. Override with -e OPENCODE_CONFIG_CONTENT=... to pin a provider.
# Quotes are escaped because Docker's legacy ENV form strips plain "..." from the value.
ENV OPENCODE_CONFIG_CONTENT="{\"websearch\":{\"provider\":\"random\"}}"

# EXPOSE is metadata only: it publishes nothing and filters nothing. Reachability comes from the run-time
# mapping (-p HOST:CONTAINER) plus the process binding 0.0.0.0 (src/index.mjs does).
# Verified: a container whose image declares only 8000/tcp served http://127.0.0.1:18001 fine via -p 18001:9999.
EXPOSE 8000

# Health status belongs to Docker, not to the gateway process (the old in-process 60s self-test is gone).
# node:22-slim has no curl, so the check is a node script; it reads the port and the Bearer key from the
# container's own environment, so no credential appears in this command line or in any image layer.
# It reports healthy only when GET /health answers 200 with status=ok, i.e. the opencode backend is
# reachable too: a running gateway that cannot serve inference is not healthy. With auth on and the
# key list empty, /health returns 401 and the container shows unhealthy — which matches the startup
# error log, and clears as soon as a real config/.keys (or API_KEY) is provided.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "/app/scripts/docker-healthcheck.mjs"]

CMD ["npm", "start"]
