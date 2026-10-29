# Docker 部署指南

本文只讲**容器化部署**这一条路径：镜像里有什么、`opencode` 的配置从哪来、哪些环境变量必须给、怎么一次跑通、出问题先看哪里。
本机 `npm start` 调试见 `README.md`；架构与模块职责见 `design.md`；对外接口契约见 `api.md`。

> 文中的结论分两类，混在一起会误导人，所以标明：**「实测」**= 在本项目的镜像里跑命令验证过；**「默认」**= `src/config.mjs` 里写死的兜底值。

---

## 1. 拓扑：谁连谁

```
客户端 ──HTTP/SSE──▶ 网关 (Fastify, 容器内 0.0.0.0:$PORT)
                       │  @opencode/client（HTTP Basic = OPENCODE_SERVER_PASSWORD）
                       ▼
                     opencode serve  ── 网关的子进程，127.0.0.1:$OPENCODE_SERVER_PORT，不对外
                       │
                       ├─ OpenCode 内置免费模型（opencode/*）
                       └─ 自定义 provider（默认 id = ollama-local）──▶ Ollama / OpenAI 兼容端点（容器外）
```

三个要点：
- **`opencode serve` 是网关拉起的子进程**，不是第二个容器；它的端口只在容器内可达（`design.md` §4.1）。
- 网关只监听 `0.0.0.0`，对外可达性完全由 `-p 宿主机端口:容器端口` 决定（§6）。
- 自定义模型的来源是 **`opencode` 的 provider 声明**，不是网关的代码或 `config.yaml`（§2、§3）。

---

## 2. `opencode` 的配置文件从哪来（最容易搞错的一步）

### 2.1 它不会自动创建 `opencode.json`

**实测**：全新镜像里 `find / -name opencode.json` 一无所有；跑完 `opencode models`、甚至跑完 `opencode serve` 之后再看，仍然只有 `~/.local/share/opencode/opencode.db`（状态库）被创建。

也就是说「装了 opencode，它会根据环境变量自动生成一份 opencode.json」这个预期是错的：**配置文件只有读、没有写**；opencode 会写的只有 `~/.local/share/opencode/` 下的状态库与 `auth.json`（登录/跑过交互会话之后才有内容）。这正是「同一台宿主机上本机跑得好、容器里没有自定义模型」的根因——本机那份配置在全局目录或状态库里，容器里两样都没有。**镜像必须自己带一份**，这就是构建期把模板复制成 `/app/config/opencode.json` 的理由（§2.4）。

### 2.2 它读哪些位置，哪个能声明自定义 provider

| 来源 | 位置 | 本镜像的状态 | 能否声明 `providers` |
|:-----|:-----|:-------------|:-------------------|
| 默认全局目录 | `~/.config/opencode/opencode.json`（`.jsonc` 同样识别） | 容器里 `/root/.config` 是空的 | 能（**实测**） |
| `OPENCODE_CONFIG_DIR` 指向的目录 | `<dir>/opencode.json` | **镜像预设为 `/app/config`**，且**构建期就烘了一份 `/app/config/opencode.json`**（来源是入库模板 `config/opencode.json.example`）← 本部署走这条 | 能（**实测**） |
| 项目目录 | `<cwd>/opencode.json` | `OPENCODE_DISABLE_PROJECT_CONFIG=true` 已关 | 关掉时不读 |
| `OPENCODE_CONFIG` | 显式文件路径 | 未设置 | 能 |
| `OPENCODE_CONFIG_CONTENT` | 内联 JSON 文本 | 镜像预设 `{"websearch":{"provider":"random"}}` | **不能**（**实测**：内联里声明 `providers` 不会注册） |

结论：**自定义 provider 必须来自一个真实的 JSON 文件**，`OPENCODE_CONFIG_CONTENT` 不是文件，它够用 `websearch` 这类键、用来声明 provider 是无效的（别在这上面耗时间）。既然 opencode 不会自己写这个文件，镜像就在构建期把模板复制了一份放到 `/app/config/opencode.json`——于是**裸 `docker run` 也算一次完整部署**（§5.3 路线 A）。

> 上表的「实测」都指**镜像内（Linux 二进制）**。同一份探测文件在 Windows 宿主的 CLI 上走 `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG` 两条路都没有注册出 provider（`opencode models` 里不出现）；本机跑得到的自定义 provider，实际来自全局 `~/.config/opencode/opencode.json`。也就是说这两个变量在容器里可靠、在本机别指望——本机要换 provider 配置，改全局那份或项目根 `opencode.json`。

### 2.3 `{env:VAR}` 插值的边界

**实测**：`{env:VAR}` 只会替换配置里的**值**，不替换**键**。把 provider 写成 `"providers": {"{env:OC_P}": {...}}` 不会注册任何 provider；同一份内容把键写成字面量就能注册。插值取自 `opencode` 自身的 `env` 段或进程环境变量，**变量没设置时替换成空串**（不是报错）。

所以：
- provider 的 **id 必须字面写在文件里**（`providers.<id>` 的键，通常还要 `name` 同值）。
- provider 的 **密钥不必写进文件**：`"apiKey": "{env:OLLAMA_API_KEY}"`，真值只在运行期环境里给。这条让 `config/opencode.json` 从「含明文密钥的敏感文件」降级成「可以随挂载走的普通配置」，也是模板**能烘进镜像层**的前提（§2.4）。
- `baseURL` 同样可以插值，换 Ollama 地址时能少改文件：`"baseURL": "{env:OLLAMA_BASE_URL}"`。

### 2.4 烘进镜像的默认值长什么样，什么时候会被顶掉

镜像里那份 `/app/config/opencode.json` 就是仓库里的 `config/opencode.json.example`：provider id `ollama-local`、`baseURL` 指向 `http://host.docker.internal:11434/v1`、`apiKey` 写成 `{env:OLLAMA_API_KEY}`；`models` 默认**为空**——**默认部署不预置任何 Ollama 模型**，要哪些模型由你在按 §5.1 挂载的文件里自己声明（并同步 `config.yaml` 的 `models.allow`，§3）。**真实那份 `config/opencode.json` 永远不进镜像**：`.dockerignore` 把它整条排除，`COPY` 只取模板——因为本机文件里可能写着明文 `apiKey`，而镜像层推出去就收不回来（`AGENTS.md` §5）。

顶掉它的两种方式：

| 方式 | 效果 | 注意 |
|:-----|:-----|:-----|
| `-v ./config:/app/config:ro` | **整目录替换**：容器看到的 `/app/config` 就是宿主那个目录 | 宿主目录里没有 `opencode.json`，烘进镜像的那份就**一起消失**（不是叠加）。这是最常见的「明明挂了卷却没有自定义模型」 |
| `-v ./config/opencode.json:/app/config/opencode.json:ro` | 只顶掉 provider 配置，`config.yaml` / `.keys` 继续用镜像里那份 | 想「只改一个文件」时用这种，代价是挂载项变多 |

**自定义 provider 端点不存在也不影响部署本身**（**实测**：`baseURL` 写成 `http://unreachable.invalid:11434/v1`、`OLLAMA_API_KEY` 不设置，provider 照样注册、**已声明的**模型照样出现在 `/v1/models`）。模型清单来自声明、不来自探活（**实测**：`models` 为空时 `/v1/models` 没有该 provider 的条目，不会自动发现端点上的模型）；真正打过去才失败，表现为推理 `502`，而 `/health` 仍是 `ok`（它探的是容器内的 `opencode serve`，不是 Ollama）。

---

## 3. 一个名字，三处一致（改 provider id 的检查表）

默认 id 是 `ollama-local`。网关用它做两件事：把这些模型排除出 `auto` 池、以及 `web-search` 缺省时挑首个本地模型（`api.md` §7.2、§8.2）。改名时**三处必须一致**，少一处就出现「网关健康但模型不见了」：

| # | 位置 | 写什么 |
|:--|:-----|:-------|
| 1 | `config/opencode.json` | `providers.<id>` 的**键**（以及该对象的 `name`） |
| 2 | 环境变量 | `OLLAMA_LOCAL_PROVIDER=<id>`（默认 `ollama-local`；值会转小写，**不能是 `ollama`**——那是 OpenCode 内置 provider 的命名空间，给了就在启动时直接报错） |
| 3 | `config/config.yaml` | `models.allow` 里 `^ollama-local/<模型>$` 这类显式条目（**逐个列出，不用 `ollama-local/.*` 通配**，否则本地全部缓存模型都会被列出来），以及 `ollama.aliases` 的值 `ollama-local/<模型>` |

两个失败模式各自都有明确日志，不用猜（**实测**）：

- 第 2 步改了、第 1 步没改 → 启动日志 `no model uses the local provider prefix (check the providers key in opencode.json and OLLAMA_LOCAL_PROVIDER)`，同时 `/health` 仍然 `ok`。
- 第 1、2 步一致、第 3 步的 `allow` 没跟上 → `/v1/models` 请求触发 `models.allow matched none of the local provider models (check the OLLAMA_LOCAL_PROVIDER name against the allow regexes)`。

网关启动日志里带 `localProvider` 字段，先确认它等于文件里的键，再往下看。

---

## 4. 环境变量总表

### 4.1 生产部署要自己给（沿用默认值就是坏部署）

| 变量 | 默认 | 不给的后果 |
|:-----|:-----|:-----------|
| `OPENCODE_SERVER_PASSWORD` | 镜像占位 `88888888` | 用占位值也能跑（容器内 `127.0.0.1` 的监听），但它是一个**写死在镜像层里**的凭据：生产环境请 `-e` 换成真值，尤其**不要**在设置 `OPENCODE_SERVER_URL` 指向远端实例时继续用它。彻底留空时网关拉起的 `opencode serve` 会拒绝客户端，模型清单直接失败（**实测**报 `Authentication required`） |
| `API_KEY`（或 `config/.keys`） | 空 | 开了 `API_KEY_ENABLED=true` 却一条 key 都没有 ⇒ 所有请求 `401`，且容器 `HEALTHCHECK` 判 unhealthy |

镜像自带的 `config/opencode.json`（§2.4）已注册好 provider，但 `models` 默认为空——所以**provider 配置是「不给也能起」的一项**（裸跑网关与内置模型照常）；要让 `/v1/models` 出现自定义模型，才需要按 §5.1 声明并挂载自己的文件。

### 4.2 镜像已经给了默认值，按需覆盖（不用重建镜像）

| 变量 | 镜像默认 | 什么时候要改 |
|:-----|:---------|:-------------|
| `PORT` | `8000` | 只在你想改**容器内**端口时改；对外端口靠 `-p`，不是改这个（§6） |
| `OPENCODE_SERVER_PORT` | `10001` | 容器内后端端口，一般不动 |
| `OPENCODE_SERVER_URL` | 空 | 设置后**不再**在容器内拉起 `opencode serve`，改为连接外部实例（复用已登录态时用） |
| `LOG_LEVEL` | `info` | 排障时 `debug`；用量与告警日志都在 `info` 级别 |
| `CONFIG_PATH` | `/app/config/config.yaml` | 挂载路径变了才改 |
| `API_KEY_ENABLED` | `false` | 默认关，方便裸 `docker run` 直接试；对外暴露就 `-e API_KEY_ENABLED=true` 并准备 `config/.keys` |
| `API_KEYS_FILE` | `/app/config/.keys` | 一般不动。**别把宿主机路径（`D:\...\config\.keys`）传进来**：容器里那个路径不存在 ⇒ key 清单为空 ⇒ 全线 `401`，而日志里一切正常 |
| `OLLAMA_LOCAL_PROVIDER` | `ollama-local` | 见 §3 检查表；改名时镜像里烘的 `/app/config/opencode.json` 的 `providers` 键也要跟着改（即挂载自己的文件） |
| `OPENCODE_CONFIG_DIR` | `/app/config` | 本部署的配置入口；那个目录里已经有烘进去的 `config.yaml` + `opencode.json`（§2.4），换挂载点才改 |
| `OPENCODE_DISABLE_PROJECT_CONFIG` / `_CLAUDE_CODE` / `_CLAUDE_CODE_SKILLS` / `_AUTOUPDATE` / `_FILEWATCHER` | `true` | 上下文裁剪项，名字逐个对 2.2.0 二进制核过；除非你在排查 `opencode` 行为，否则别动 |
| `OPENCODE_CONFIG_CONTENT` | `{"websearch":{"provider":"random"}}` | **整体替换**而非合并：要固定检索后端就写全 `{"websearch":{"provider":"tavily","apiKey":"{env:TAVILY_API_KEY}"}}` |

### 4.3 网关不读、只透传给 `opencode serve` 的密钥

`OLLAMA_API_KEY`、`TAVILY_API_KEY` 等 provider 密钥只作为环境变量存在，由 §2.3 的 `{env:VAR}` 插值在 `opencode` 侧取用。**不进镜像层、不进日志、不进错误响应**（`AGENTS.md` §5），镜像里也**没有**它们的 `ENV` 默认值（名字含 `API_KEY`，写进 `ENV` 只会多一条 BuildKit 告警，见 §4.4）。

不设置会怎样：**不设置也能起**（**实测**——`{env:...}` 缺失插值成空串，provider 照样注册、模型照样列出）。Ollama 本身不校验 key，所以本机试跑可以完全不传；换成真正校验 Authorization 的 OpenAI 兼容端点时，这个值才是必填的。

### 4.4 两条通用语义

- **空串等于未设置**：`-e OPENCODE_SERVER_URL=` 或 `--env-file` 里留空，都会落回默认值，不会因「空字符串不合法」启动失败（`src/config.mjs` 的 `emptyToUndefined`）。
- **真实环境变量优先于 `.env`**：容器里没有 `.env`（`.dockerignore` 排除），所以容器里永远是环境说话算数。
- 镜像 `ENV` 里 `API_KEY_ENABLED` / `API_KEYS_FILE` 这两个名字含 `API_KEY`，`docker build` 会打一条 `SecretsUsedInArgOrEnv` 告警。它们是开关和路径、不是密钥，**这条告警属于预期**，不要为此把默认值挪进构建参数。

---

## 5. 从零部署一遍

### 5.1 要不要准备运行期配置目录

**不准备也行**——镜像自带 `config.yaml` + `opencode.json`（§2.4），路线 A 直接跳到 §5.3。只有下面这些才需要你准备一个宿主机目录（下面统一叫 `./config`）：

```
./config/opencode.json    # 换 provider id / Ollama 地址 / 模型清单
./config/.keys            # 开启鉴权时：一行一个明文 key
./config/config.yaml      # 覆盖业务默认值（白名单、别名、检索参数）
```

自己的 `opencode.json` 从 `config/opencode.json.example` 复制后改，最小形态：

```json
{
  "plugins": ["-opencode.provider.ollama"],
  "providers": {
    "ollama-local": {
      "name": "ollama-local",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://host.docker.internal:11434/v1",
        "apiKey": "{env:OLLAMA_API_KEY}"
      },
      "models": {
        "qwen3.5:9b": { "name": "Qwen3.5-9B (Ollama)" }
      }
    }
  },
  "websearch": { "provider": "random" }
}
```

- `providers` 的键必须等于 `OLLAMA_LOCAL_PROVIDER`（§3），否则 `/v1/models` 里看不到、且日志会给明确告警。
- `plugins: ["-opencode.provider.ollama"]` 关掉 OpenCode 内置的 `ollama` provider，改由显式声明接管；因此 `ollama/<id>` 这条路径要等你在 `providers.ollama.models` 里声明之后才有模型（`OLLAMA_LOCAL_PROVIDER` 不能占用 `ollama` 这个名字，原因就在这）。
- **容器里 `localhost` 指的是容器自己**。宿主机上的 Ollama 用 `http://host.docker.internal:11434/v1`（Linux 需 `--add-host=host.docker.internal:host-gateway`），局域网另起的机器就直接写 `http://<该机器IP>:11434/v1`。
- **`models` 默认为空是特意设计的**：镜像的默认部署**不预置任何 Ollama 模型**，要哪些由你自己选择——先 `ollama pull`，把 `ollama list` 里的真实模型名一字不差写进 `providers.<id>.models`，**并同步 `config.yaml` 的 `models.allow`**（§3，逐个列出、别用通配），否则模型列不出来（日志会给 warn 而不是静默消失）。
- 挂载 `./config` 是**整目录替换**：目录里没放 `opencode.json`，镜像烘的那份就一起没了（§2.4）。只想改一个文件就用单文件挂载。

### 5.2 构建

```bash
docker build \
  --build-arg APP_VERSION="$(node -p "require('./package.json').version")" \
  --build-arg OPENCODE_CLI_VERSION="$(node -p "require('./package.json').dependencies['@opencode/client']")" \
  -t opencode-gateway:latest .
```

`OPENCODE_CLI_VERSION` 必须与 `package.json` 里 `@opencode/client` 同版本（客户端由服务端 OpenAPI 规范生成，跨版本直接对不上字段，`AGENTS.md` §6）——所以两个构建参数都从 `package.json` 现取，**不要在这里手写版本号**（手写就是第二套事实源，升级时最容易漏）。`package-lock.json` 必须入库，`npm ci` 没锁文件会直接构建失败。

**Windows：`scripts\docker-build.bat` 与 `scripts\docker-publish.bat`** 把「构建」和「推送」收成一个动作。它们只替你敲命令，不替你负责：

| 脚本 | 做什么 | 挡住的是什么 |
|:-----|:-------|:-------------|
| `docker-build.bat` | `npm run check` 绿了才 `docker build`；`APP_VERSION` 与 `OPENCODE_CLI_VERSION` 都从 `package.json` 读（前者取 `version`，后者取 `dependencies["@opencode/client"]`）；同一次构建同时打 `<version>` 和 `latest`；`--no-check` 是唯一跳过门槛的开关 | 构建出跑不过 lint/test 的镜像；`--build-arg` 里的 CLI 版本与 lock 里的 client 版本各说各话；`latest` 落后于你实测过的那个版本 |
| `docker-publish.bat` | 不构建：先要求两个标签都在本地且指向**同一个 image id**，打印构建时间与 id，再要求手输仓库名才 `docker push` | 推一份本地没测过的东西上去；`latest` 被推到另一个镜像上；一次误触把层永久留在公共仓库 |

仓库名两个脚本共用，默认 `bruce1977/opencode-port`，`set IMAGE_REPO=<ns>/<name>` 覆盖（所以它和上面示例里的 `opencode-gateway:latest` 只是名字不同，`docker run` 用哪个都一样）。凭据仍然只走 `docker login`，脚本不读、不存、也不代填密码。`*.bat` 由 `.dockerignore` 排除：它们在宿主机对着宿主机的 Docker 守护进程跑，容器里的进程永远不读它们——`scripts/` 之所以还要打包，只因为 `HEALTHCHECK` 要执行 `docker-healthcheck.mjs`。BuildKit 那条 `SecretsUsedInArgOrEnv` 告警照样会出现，语义见 §4.4。

### 5.3 运行

**路线 A — 一键部署（不挂载，用镜像里烘好的配置）**

```bash
docker run -d --name opencode-gateway --restart unless-stopped \
  -e OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 16)" \
  --add-host=host.docker.internal:host-gateway \
  -p 10000:8000 \
  opencode-gateway:latest
```

起来之后 `/v1/models` 是**内置模型 + 虚拟 `auto`**；`API_KEY_ENABLED` 默认 `false`，所以这一步不需要 key。**默认不预置 Ollama 模型**：镜像模板里 `models` 为空（有意为之，§5.1），这一步**没有** `ollama-local/*`，也没有 Ollama 依赖——宿主机有没有 `11434` 都不影响（§2.4）。想用本地模型就走路线 B 声明后挂载。`--add-host` 只有 Linux 需要——Docker Desktop（Windows/macOS）自带 `host.docker.internal`，多写一次也无害。

**路线 B — 挂载覆盖（改 provider / 开鉴权 / 改业务默认值）**

```bash
docker run -d --name opencode-gateway --restart unless-stopped \
  -v "$(pwd)/config:/app/config:ro" \
  -e OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 16)" \
  -e OLLAMA_API_KEY \
  -e API_KEY_ENABLED=true \
  --add-host=host.docker.internal:host-gateway \
  -p 10000:8000 \
  opencode-gateway:latest
```

- `-v ...:/app/config:ro`：一个只读卷同时提供 `opencode.json` / `.keys` / `config.yaml`，改配置后 `docker restart` 即生效，**不需要重建镜像**；代价是它会整目录替换掉烘进镜像的默认值（§2.4）。
- **只读挂载对 `opencode serve` 没问题**（**实测**：容器 `Up`、正常监听）。但别在容器里手跑 `opencode models`——它会往配置目录写 `service.json`，只读卷上直接 `EROFS` 退出；那是 CLI 的行为，不是网关的。
- 密钥用 `-e NAME`（不带 `=`）的形式从宿主环境透传，值不进命令行历史、不进 `docker inspect` 的 `Env` 之外的地方；整套部署项更适合放进一个 `--env-file`（注意 §4.2 里「不要把宿主机路径传进来」那条）。
- `-p 10000:8000` 左侧是宿主机端口，右侧是**容器内**端口（镜像默认 `PORT=8000`）。

### 5.4 冒烟（顺序别换，每步都排除一类问题）

```bash
KEY=$(grep -v '^#' ./config/.keys 2>/dev/null | grep -v '^[[:space:]]*$' | head -1)   # 路线 A 没有这个文件，留空即可

curl -s ${KEY:+-H "Authorization: Bearer $KEY"} http://127.0.0.1:10000/health     # status=ok + 后端版本
curl -s ${KEY:+-H "Authorization: Bearer $KEY"} http://127.0.0.1:10000/v1/models   # 内置免费模型 + 虚拟 auto（默认无 ollama-local/*）
curl -s -N ${KEY:+-H "Authorization: Bearer $KEY"} -H "content-type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:10000/v1/chat/completions                                       # 有 SSE 增量即通
```

第三条用 `auto` 意在覆盖默认部署的完整链路：`auto` 只从内置模型池随机选一款，不依赖 Ollama——路线 A 下宿主机有没有 `11434` 都不影响。想验本地链路再补这一条（前提：已按路线 B 声明并在 `models.allow` 放行了本地模型）。它才是唯一真依赖 Ollama 的一步：provider 端点不通时返回 `502`，而前两条照常通过——这正是「provider 端点不存在不影响部署」的表现（§2.4）。

```bash
curl -s -N ${KEY:+-H "Authorization: Bearer $KEY"} -H "content-type: application/json" \
  -d '{"model":"ollama-local/<你声明的模型>","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:10000/v1/chat/completions
```

`/health` 的 `opencode.mode` 说明后端是谁管的：`managed` = 网关拉起的子进程，`reused` = 配置端口上已有 OpenCode 实例、直接连它（生命周期不归网关管），`external` = 设置了 `OPENCODE_SERVER_URL` 指向外部实例。

### 5.5 看健康与日志

```bash
docker inspect --format '{{json .State.Health}}' opencode-gateway   # 每次探测的判定行都在 Output 里
docker logs -f opencode-gateway
```

健康判定由容器层负责（网关进程内没有任何定时器）：`HEALTHCHECK` 每 30s 用 `node /app/scripts/docker-healthcheck.mjs` 请求自身 `/health`，**只有 HTTP 2xx 且响应体 `status=ok` 才算健康**——后端不可达时 `/health` 仍返回 200 + `degraded`，只看状态码会漏（`design.md` §5.8）。

---

## 6. 端口：`EXPOSE`、`-p` 与「访问不通」

| 说法/现象 | 事实 |
|:---------|:-----|
| 「`EXPOSE` 决定能访问哪个端口」 | 错。**`EXPOSE` 既不发布也不过滤**（**实测**：只声明 `8000/tcp` 的镜像，用 `-p 18001:9999` 照样通）。它只是元数据，唯一实质作用是 `docker run -P`（publish-all）会把它当白名单 |
| 「改 `EXPOSE` 就能换宿主机端口」 | 错。宿主机端口只由 `-p 宿主:容器` 决定；容器内端口由 `PORT` 决定，两者必须成对写 |
| 浏览器 `ERR_UNSAFE_PORT`，但 `curl` 通 | **Chromium 的受限端口表**（`10080` 在表里）。不是服务的问题，换端口即可（`10081`/`8081`/任意高位非黑名单端口） |
| `Bind for 0.0.0.0:10000 failed: port is already allocated` | 宿主机端口被占（常见就是本机 `npm start` 的那个进程，`netstat -ano \| grep 10000` 看归属） |
| `--network host` 后本机访问不到 | Docker Desktop 的「host」是 **VM 的** host，不是 Windows 的。要宿主机可达就用 `-p` |

---

## 7. 故障 → 先看哪里

| 症状 | 第一步 | 已验证的解释 |
|:-----|:-------|:-------------|
| 所有请求 `401` | 启动日志的 `keysFile` / `keyCount` 那条 error/warn | 开了鉴权却没读到 key：`.keys` 没挂上、或把宿主机路径传进了容器（§4.2）。key 值不会出现在日志里 |
| `/health` 返回 `degraded` | `docker logs` 里 `opencode serve` 的输出 | 后端不可达。`OPENCODE_SERVER_PASSWORD` 为空尤其常见（§4.1） |
| `/v1/models` 里只有内置模型 | `docker exec opencode-gateway ls /app/config` | 三种常见原因：① 挂了 `./config` 但目录里没有 `opencode.json`（整目录替换把镜像烘的那份也顶掉了，§2.4）；② provider id 三处不一致（§3）；③ 把 provider 写进了 `OPENCODE_CONFIG_CONTENT`（§2.2，不生效）。再看启动日志的 `localProvider` 字段与两条告警 |
| 自定义模型有清单但请求 502 | 容器内能否到达 `baseURL` | `localhost` 在容器里不是宿主机（§5.1）；Linux 上 `host.docker.internal` 需要 `--add-host=host.docker.internal:host-gateway`；清单本来就不依赖端点可达（§2.4），所以「能列出」不等于「能推理」 |
| 容器里手跑 `opencode models` 报 `EROFS: read-only file system ... service.json` | 不是故障 | CLI 会往配置目录写 `service.json`，只读卷上必然失败；`opencode serve`（网关实际拉起的）不写也能跑（**实测**）。要就用单文件挂载，要么就别在容器里跑 CLI |
| 改了 `config.yaml` / `opencode.json` 没效果 | 先确认改的是哪一份 | 配置只在启动时读一次，只读挂载不会自动重载 ⇒ `docker restart`。若走路线 A（没挂载），你改的是**仓库里**的文件，容器看到的仍是镜像里烘的那份 ⇒ 要么挂载，要么重建镜像 |
| 容器一直 `unhealthy` 但接口能用 | `docker inspect` 的 `Health.Output` | 判定要求 `status=ok`；后端 `degraded`、或鉴权开着却没 key（探测拿 401）都会报 unhealthy——这不是误报 |
| 构建时 `SecretsUsedInArgOrEnv` 告警 | 忽略 | 镜像里 `API_KEY_ENABLED` / `API_KEYS_FILE` 只是**名字**撞了规则，值不是密钥（§4.4） |
| 镜像里出现 `config;D` 之类怪目录 | 检查构建上下文 | Windows/MSYS 会把带 `:` 的参数重写成 `;` 拼接的路径。别用 `COPY . .`（本镜像只选择性 `COPY`），Git Bash 下操作 docker 时先 `export MSYS_NO_PATHCONV=1` |

---

## 8. 升级、回滚与镜像边界

- **升级顺序**：`Dockerfile` 的 `ARG OPENCODE_CLI_VERSION` → `package.json` 的 `@opencode/client` → `npm install` 更新 lock → `npm run check` → 接真实 `opencode serve` 冒烟（`/v1/models` + 一次流式 chat）。
- **回滚** = 换 tag 重新 `docker run`。密钥仍全在运行期环境里，镜像层不含任何凭据，旧镜像可以放心留着；注意路线 A 下**默认 provider 配置是跟着镜像走的**，回滚镜像会连模型清单一起退回旧版。
- **镜像里只有运行期读得到的东西**：`src/`、`scripts/`、`config/config.yaml`、由 `config/opencode.json.example` 复制而来的 `/app/config/opencode.json`、一个空的 `config/.keys`、`node_modules`。`.env`、真实 `config/opencode.json`、真实 `config/.keys` 由 `.dockerignore` 排除。`scripts/` 打包只因为 `HEALTHCHECK` 要执行 `docker-healthcheck.mjs`；同目录下的 `*.bat` 是宿主机脚本，容器永不读取，同样被排除在外。
- **`config/opencode.json.example` 现在有两个消费者**：本机/挂载副本的起点模板，以及镜像烘进去的默认 provider 配置。改它 = 改镜像默认值，需要重新构建；想在不重建的前提下换配置，就用挂载（§5.3 路线 B）。
- **能不能把真实 `config/opencode.json` 烘进镜像？** 技术上只要删掉 `.dockerignore` 那行、把 `COPY` 的源改成它就行，**前提是文件里的 `apiKey` 已经是 `{env:...}` 形式**（§2.3）。明文密钥一旦进镜像层就永久存在，推出去收不回来，所以本项目的做法是「烘模板、排除真文件」，两者兼得（§2.4）。

---

## 9. 相关文档

| 需要 | 去哪 |
|:-----|:-----|
| 用法、端点示例、模型命名 | `README.md` |
| 接口字段与错误码（唯一事实源） | `docs/api.md` |
| 模块职责、启动与推理流程、配置分层 | `docs/design.md` |
| 协作与代码规范（含配置分层铁律） | `AGENTS.md` |
