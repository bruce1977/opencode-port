# AGENTS.md

本仓库的协作与代码规范正文。`config/eslint.config.mjs` 只负责把其中**可由 AST 判定**的部分变成可执行检查（`npm run lint` 经 `--config` 指定）；
两者冲突时以本文件为准，并同步修正配置。

---

## 1. 项目是什么

启动（或复用）`opencode serve`，通过 `@opencode/client` 与它通信，把 OpenCode 的**内置免费模型**与部分能力包装成标准 API：

| 端点 | 说明 |
|:-----|:-----|
| `GET /health` | 健康检查（含后端连通性） |
| `GET /v1/models` | 模型列表（含虚拟模型 `auto`） |
| `GET /v1/aliases` | 模型别名列表（`models.aliases` / `ollama.aliases`） |
| `POST /v1/chat/completions` | OpenAI Chat Completions（SSE） |
| `POST /v1/responses` | OpenAI Responses API（SSE） |
| `POST /v1/messages` | Anthropic Messages API（SSE） |
| `POST /v1/web_search` | 独立检索 API，**必须指定内置模型** |

文档索引：`README.md`（用法）→ `docs/design.md`（架构与流程）→ `docs/api.md`（接口契约，唯一事实源）→ `docs/docker-deployment.md`（容器化部署：配置发现顺序、环境变量总表、故障判别）。

---

## 2. 运行环境与技术栈

| 项 | 约定 |
|:---|:-----|
| 语言 | **纯 JavaScript（ESM，扩展名 `.mjs`）**，不引入 TypeScript、不引入构建步骤 |
| Node | `^20.19.0 \|\| ^22.13.0 \|\| >=24`（ESLint 10 的下限，见 `package.json` `engines`） |
| HTTP | Fastify 5（SSE 直接写 `reply.raw`） |
| 校验 | zod 4（环境变量 + `config/config.yaml`） |
| YAML | `yaml` 2 |
| 后端 SDK | `@opencode/client`，**版本锁定且必须与镜像内 `@opencode/cli` 同版本** |

- 类型提示用 JSDoc（可选，可加 `// @ts-check`），不得因此引入 `tsc` 或打包器。
- 运行期依赖保持在 6 个以内（在原有 4 个基础上增加 `@fastify/swagger` / `@fastify/swagger-ui`：Fastify 自身不生成 OpenAPI 文档与 UI，手写静态规范会与路由 schema 形成第二套事实源）；新增依赖需要说明「为什么标准库/Fastify 自带能力不够」。

---

## 3. 目录与职责

```
src/index.mjs        进程入口：加载 .env → 装配配置 → 启动 Fastify → 拉起/复用 opencode serve → 模型清单（健康状态由容器层 HEALTHCHECK 负责，进程内不跑定时器）
src/startup-report.mjs 启动清单：把可用模型按 provider 输出到终端（只做展示）
src/core/            机制层：server-manager / opencode-client / model-resolver / session-store
src/api/routes/      协议层：health / models / chat / responses / messages / web-search
src/tools/           检索实现：服务端 websearch 优先 + SearchProvider 兜底
scripts/             一次性运维与自检脚本（与源码同一套 lint 规则）；docker-healthcheck.mjs 是 Docker HEALTHCHECK 的执行体，需随镜像打包；docker-build.bat / docker-publish.bat 在宿主机跑，不进镜像（.dockerignore 排除 `*.bat`）
tests/               node:test 用例，命名 *.test.mjs
config/              业务默认值与工具配置（config.yaml 直接入库；opencode.json.example 与 .keys.example 是模板；eslint.config.mjs；
                     实际 opencode.json 与 .keys 不入库、不进镜像；opencode.json.example 构建期复制成镜像的 /app/config/opencode.json）
docs/                设计文档与 API 契约（docker-deployment.md 是容器化部署）
```

**依赖方向**：`api` / `tools` → `core`。`core` 不得 import `api` 或 `tools`（lint 已强制）。
新增跨层调用前先问：这段逻辑属于「机制」还是「协议」？

---

## 4. JS 代码规范（强制）

### 4.1 门槛

- 任何 `.mjs` 文件的改动，交付前必须 **`npm run lint` 零 error**；当前 warning 基线为 0，同样不要新增。
- 完整自检：**`npm run check`**（`lint` + `test`）。
- 不得为了让检查通过而做以下任何一件事：
  - 改 `config/eslint.config.mjs` 的 `ignores` / `files`，把新代码排除在检查外；
  - 加整文件 `/* eslint-disable */`；
  - 把规则降级为 `warn` / `off`。
- 确需豁免时：用最小范围 `// eslint-disable-next-line <rule> -- <原因>`，且在交付说明里写明原因，
  并由 `reportUnusedDisableDirectives: "error"` 保证「禁用了却没触发」同样报错。

### 4.2 编码约定（lint 可判定）

| 规则 | 约定 |
|:-----|:-----|
| 缩进 | 2 空格，`switch` 的 `case` 缩进 1 级 |
| 字符串 | 双引号；内部含双引号时可用单引号；模板串允许 |
| 分号 | 必须 |
| 变量 | 只用 `const` / `let`，禁 `var`；能 `const` 就 `const` |
| 比较 | `===`（与 `null` 比较除外） |
| import | 相对路径**必须带 `.mjs` 扩展名**（Node ESM 不会自动补全） |
| 未使用变量 | 报错；确需忽略用 `_` 前缀或 `ignoreRestSiblings` 场景 |
| 作用域 | 禁 `no-shadow` |
| 空 catch | 允许（`allowEmptyCatch`），但要在注释里说明为什么可以吞 |

### 4.3 手工约定（lint 判不出，评审把关）

- 一个模块只做一件事；文件接近 400 行就该考虑拆分。
- 对外错误统一 `{ "error": { "message", "type", "code" } }`；**不向客户端泄漏堆栈、文件路径与密钥**。
- 日志走 Fastify 的 logger（pino）；提交里不留 `console.log`。
- 所有出站请求（opencode server、Ollama、搜索后端、网页抓取）必须有 **超时 + AbortSignal**，不允许裸 fetch。
- 配置只从 `AppConfig` 读，业务代码里不出现 `process.env.XXX`。
- 流式响应的错误处理：一旦开始写 SSE，就不能再改状态码；用流内 `error` 事件表达失败。

### 4.4 新增或调整规则

先改本节 → 再改 `config/eslint.config.mjs` → 跑 `npm run lint` 确认基线仍为 0。
规则 `message` 要写「违反了哪条约定」，而不是复述规则名。

---

## 5. 配置分层（铁律）

| 层 | 载体 | 只放 | 不放 |
|:---|:-----|:-----|:-----|
| 版本 + 部署默认值 | `Dockerfile` 的 `ARG` / `ENV` + `package.json`/lock | `@opencode/cli` 与 `@opencode/client` 版本；**非敏感部署项的镜像内默认值**（`PORT` / `OPENCODE_SERVER_PORT` / `OPENCODE_SERVER_URL` / `LOG_LEVEL` / `CONFIG_PATH` / `OLLAMA_LOCAL_PROVIDER`，以及开关 `API_KEY_ENABLED=false` 与路径 `API_KEYS_FILE=/app/config/.keys`）；`OPENCODE_SERVER_PASSWORD` 只允许**内部占位值**（保护容器内 `127.0.0.1` 那条链路，文档要求上线前 `-e` 改掉，不得用于 `OPENCODE_SERVER_URL` 指向的远端实例） | **真密钥**（`API_KEY` / `SEARCH_API_KEY` / `OLLAMA_API_KEY` / `TAVILY_API_KEY`…连 `ENV` 声明都不留）、真实 `config/opencode.json`、真实 `config/.keys`、业务默认值 |
| 部署/敏感 | 环境变量（`.env`，模板 `.env.example`；容器里 `-e` / `--env-file`） | 端口、后端地址、`OPENCODE_SERVER_PASSWORD`、`API_KEY`、`API_KEYS_FILE`、`OLLAMA_LOCAL_PROVIDER`、`SEARCH_API_KEY`、`CONFIG_PATH`、`LOG_LEVEL`，以及透传给 `opencode serve` 的 provider 密钥（`OLLAMA_API_KEY`、`TAVILY_API_KEY`…） | 业务默认值 |
| 对外凭据清单 | `config/.keys`（模板 `config/.keys.example`，**一行一个 key**；实际文件不入库、不进镜像） | 开启 `API_KEY_ENABLED` 后要接受的 key | 业务默认值、任何注释以外的字段 |
| 业务默认值 | `config/config.yaml`（直接入库，随镜像打包） | `models.allow`、`models.auto.*`、`models.aliases`、`ollama.aliases`、`web_search.*`、`search.*`、`session.ttl_min` | 任何密钥 |
| Provider | `config/opencode.json`（模板 `config/opencode.json.example`，实际文件不入库） | `providers.<id>` 的 baseURL 与模型声明、`websearch.provider` 声明 | 业务逻辑、明文密钥（一律写成 `{env:VAR}` 插值） |

- 密钥默认只走环境变量：**不进 `config/`、不进镜像层、不进日志、不进错误响应**。
  唯一例外是 `config/.keys`：它是**运行期凭据清单**（一行一个对外 API key，**明文存、明文比**——不加解密、不哈希、不做 `{env:VAR}` 插值），
  由 `.gitignore` + `.dockerignore` 双重排除、只通过 `./config` 只读挂载或本机文件提供；模板 `.keys.example` 才入库。
  除该文件外，任何密钥仍一律走环境变量；key 值不得出现在日志、错误响应与镜像层里（与 `OPENCODE_SERVER_PASSWORD` 同级要求）。
- **`config/opencode.json` 是「烘模板、排除真文件」**：镜像在构建期 `COPY config/opencode.json.example ./config/opencode.json`（opencode 2.2.0 只读不写这个文件，镜像不自带就没有自定义模型），
  而真实文件由 `.dockerignore` 绝对排除。这条排除是「烘 `opencode.json`」安全的前提——**只有 `{env:VAR}` 形态的 provider 配置可以进镜像层**，明文密钥一旦推出收不回来。
- `ENV` 里 `API_KEY_ENABLED` / `API_KEYS_FILE` 会触发 BuildKit 的 `SecretsUsedInArgOrEnv` 告警（按**名字**判定，值只是开关与路径）。**该告警属于预期**，不要为此把默认值挪回代码或改成 `ARG`。
- 新增配置键必须**四处同步**：`config/config.yaml`（或 `opencode.json` / 环境变量对应的那一层）、代码内默认值、`README.md` 配置表、`docs/design.md` §6；容器相关的还要同步 `docs/docker-deployment.md` §4 与 `Dockerfile` 的注释。

---

## 6. 版本耦合（最容易踩）

- `@opencode/client` 版本必须与镜像内 `@opencode/cli` **同版本**（当前 `2.2.0`）。client 由 server 的 OpenAPI 规范生成（路由前缀 `/api/*`），跨版本会直接对不上字段。
- 升级顺序：`Dockerfile` 的 `ARG OPENCODE_CLI_VERSION` → `package.json` 依赖版本 → `npm install` 更新 lock → `npm run check` → 接真实 `opencode serve` 冒烟（`/v1/models` + 一次流式 chat）。
- **`package-lock.json` 必须提交**：`Dockerfile` 使用 `npm ci`，没有 lock 直接构建失败。

---

## 7. 变更影响面

| 改动 | 必须同步 |
|:-----|:---------|
| 任何端点/字段/错误码 | `docs/api.md`（唯一事实源），涉及用法再改 `README.md` |
| 模型命名或解析优先级 | `docs/api.md` 模型命名节 + `README.md` 命名规则表 |
| 配置键 | §5 的四处 |
| 默认搜索后端 | `config/config.yaml` 注释 + `README.md` 注意事项 |
| 新增依赖 | `package.json` + 本文件 §2（说明理由） |

---

## 8. 提交前自检清单

- [ ] `npm run check` 通过（lint 零 error、零新增 warning，测试通过）
- [ ] diff 中没有 `.env`、`config/opencode.json`、`config/.keys`、任何密钥（`config/config.yaml` 本身入库，但不得含密钥）
- [ ] 新增/修改的端点与字段已进 `docs/api.md`
- [ ] 新增配置键已四处同步
- [ ] 手动冒烟：`/health` → `/v1/models` → 一次 `stream:true` 的 chat

---

## 9. 常用命令

| 命令 | 用途 |
|:-----|:-----|
| `npm run lint` | ESLint 检查（提交前必跑） |
| `npm run lint:fix` | 自动修复缩进/引号/分号等 |
| `npm test` | `node --test` 跑 `tests/**/*.test.mjs` |
| `npm run check` | lint + test，交付门槛 |
| `npm start` | 启动网关 |
| `npm run dev` | `node --watch` 热重启 |

---

## 10. 明确不做

- 不把 `web_search` 内嵌成工具/函数调用，它是独立 API。
- 不引入 TypeScript、编译步骤或打包器。
- 不默认使用付费 provider（免费模型优先，`auto` 池只含内置模型）。
- 不为「跑通」而绕过 `OPENCODE_SERVER_PASSWORD` 或 `API_KEY` 鉴权。
- 不改 lint 的 `ignores` 去掩盖问题。
