# Node 22 LTS（Node 20 已 EOL；engines 见 package.json）
FROM node:22-slim

# 版本绑定（构建期固定，不使用环境变量）
# ⚠️ 必须与 package.json 的 @opencode/client 版本一致（client 由 server 的 OpenAPI 生成，跨版本字段对不上）
ARG OPENCODE_CLI_VERSION=2.1.4

# 安装固定版本的 OpenCode CLI（2.x：@opencode/cli，postinstall 拉平台二进制）
RUN npm install -g @opencode/cli@${OPENCODE_CLI_VERSION}

WORKDIR /app

# 先装依赖以复用层缓存；npm ci 需要 package-lock.json（必须提交）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# 随镜像打包业务配置与 OpenCode provider 配置
COPY config/config.yaml /app/config/config.yaml
COPY config/opencode.json /root/.config/opencode/opencode.json
ENV CONFIG_PATH=/app/config/config.yaml

EXPOSE 10000
CMD ["npm", "start"]
