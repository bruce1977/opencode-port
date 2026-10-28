# Node 22 LTS (Node 20 is EOL; see engines in package.json)
FROM node:22-slim

LABEL org.opencontainers.image.title="OpenCode API Gateway" \
      org.opencontainers.image.description="OpenAI/Anthropic-compatible API gateway for OpenCode built-in free models and custom providers" \
      org.opencontainers.image.url="https://github.com/bruce1977/opencode-port" \
      org.opencontainers.image.source="https://github.com/bruce1977/opencode-port" \
      org.opencontainers.image.licenses="MIT"

# Version is pinned at build time (not an env var).
# WARNING: must match @opencode/client in package.json (client is generated from the server OpenAPI spec).
ARG OPENCODE_CLI_VERSION=2.2.0

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

COPY . .

# /app/config holds both config.yaml and the mounted opencode.json (single volume, OPENCODE_CONFIG_DIR).
# Deployment defaults mirror .env (src/config.mjs applies the same values when unset).
# API_KEY_ENABLED / API_KEYS_FILE stay unset here: their defaults (false, ./config/.keys — /app/config/.keys with
# this WORKDIR) live in src/config.mjs, and BuildKit flags any ENV whose *name* contains "API_KEY" as
# secret-bearing (SecretsUsedInArgOrEnv). compose does not forward API_KEYS_FILE either, so a host path
# written in .env cannot leak into the container and blank out the key list.
# OPENCODE_SERVER_PASSWORD / API_KEY / SEARCH_API_KEY are deliberately absent here: secrets are injected at
# runtime only (compose / --env-file / -e) and never become ARGs or ENVs, so they cannot reach an image layer.
# The accepted-key list config/.keys is excluded by .dockerignore for the same reason; only the template ships.
ENV PORT=10000 \
    OPENCODE_SERVER_PORT=10001 \
    OPENCODE_SERVER_URL="" \
    LOG_LEVEL=info \
    CONFIG_PATH=/app/config/config.yaml

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

EXPOSE 10000
CMD ["npm", "start"]
