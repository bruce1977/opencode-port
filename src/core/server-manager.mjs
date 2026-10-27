// 进程/服务层：拉起并管理 `opencode serve` 子进程，或复用外部实例。
// design.md §5.1：startServe / stopServe / isHealthy，退出自动重启（带退避）。
import { spawn } from "node:child_process";
import { connect } from "node:net";

const START_TIMEOUT_MS = 30000;
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const HEALTH_TIMEOUT_MS = 5000;
const PORT_PROBE_TIMEOUT_MS = 1000;
const LOCAL_HOST = "127.0.0.1";

/**
 * TCP 探测端口是否已被监听（只看端口，不做协议识别）。
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isPortOpen(host, port, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let settled = false;
    const settle = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(open);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * @param {object} options
 * @param {import("../config.mjs").AppConfig} options.config
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} options.logger
 */
export function createServerManager({ config, logger }) {
  const external = Boolean(config.serverUrl);
  let child = null;
  let stopping = false;
  let reused = false;
  let restartDelay = RESTART_BASE_MS;

  /** 本地后端地址（端口来自 OPENCODE_SERVER_PORT） */
  function localUrl() {
    return `http://${LOCAL_HOST}:${config.serverPort}`;
  }

  /**
   * 探测指定地址的 /api/info（2.x info 端点）。
   * @returns {Promise<number|null>} HTTP 状态码；连不上（未监听 / 非 HTTP 服务）返回 null
   */
  async function probeStatus(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const headers = {};
    if (config.serverPassword) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${config.serverPassword}`).toString("base64")}`;
    }
    try {
      const res = await fetch(new URL("/api/info", url), { headers, signal: controller.signal });
      return res.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 外部实例 / 已复用实例：仅做健康探测（401 也说明进程活着） */
  function probeAlive(url) {
    return probeStatus(url).then((status) => status !== null && status < 500);
  }

  /**
   * 启动 `opencode serve`。
   * Windows 下 npm 全局安装的是 `opencode.cmd` 垫片，Node 的 spawn 不能直接执行 .cmd，
   * 因此显式经 `cmd.exe /c` 启动；参数仅含固定 host 与数字端口，不含用户可控字符串。
   * @param {string[]} args
   * @param {NodeJS.ProcessEnv} env
   */
  function launchServe(args, env) {
    const options = {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    if (process.platform === "win32") {
      const comspec = process.env.ComSpec || "cmd.exe";
      return spawn(comspec, ["/d", "/s", "/c", ["opencode", ...args].join(" ")], options);
    }
    return spawn("opencode", args, options);
  }

  /** 结束子进程；Windows 下 cmd 垫片会再 fork opencode，必须杀整棵进程树，否则端口不会释放 */
  function terminateChild(proc, signal = "SIGTERM") {
    if (!proc.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      // 极少数无 taskkill 的环境：退回只结束外层进程，至少让 exit 事件按预期触发
      killer.on("error", () => proc.kill());
      killer.unref();
      return;
    }
    proc.kill(signal);
  }

  function startChild() {
    return new Promise((resolveStart, rejectStart) => {
      const args = ["serve", "--hostname=127.0.0.1", `--port=${config.serverPort}`];
      logger.debug({ args }, "spawn opencode serve");
      const proc = launchServe(args, { ...process.env, OPENCODE_SERVER_PASSWORD: config.serverPassword });
      child = proc;

      let output = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateChild(proc);
        rejectStart(new Error(`opencode serve 启动超时（${START_TIMEOUT_MS}ms）：${output.slice(-2000)}`));
      }, START_TIMEOUT_MS);

      const onData = (chunk) => {
        const text = chunk.toString();
        output += text;
        if (settled) return;
        // 启动标志：2.x 为 "server listening on http://..."，1.x 为 "opencode server listening on ..."
        const match = output.match(/server listening[^\n]*?(https?:\/\/[^\s]+)/);
        if (match) {
          settled = true;
          clearTimeout(timer);
          resolveStart(match[1]);
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });

      proc.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectStart(new Error(`无法执行 opencode CLI（请确认已安装且在 PATH 中）：${error.message}`));
      });

      proc.on("exit", (code, signal) => {
        clearTimeout(timer);
        child = null;
        if (!settled) {
          settled = true;
          rejectStart(new Error(`opencode serve 启动即退出（code=${code} signal=${signal}）：${output.slice(-2000)}`));
          return;
        }
        if (stopping) return;
        // 意外退出 → 退避重启（design.md §5.1）
        logger.error({ code, signal }, "opencode serve 意外退出，准备自动重启");
        const delay = restartDelay;
        restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
        setTimeout(() => {
          if (stopping) return;
          startChild().catch((error) => {
            logger.error({ err: error }, "opencode serve 重启失败");
          });
        }, delay);
      });
    });
  }

  async function startServe() {
    if (external) {
      const status = await probeStatus(config.serverUrl);
      if (status === null) {
        logger.warn({ url: config.serverUrl }, "外部 opencode serve 当前不可达，网关仍按配置连接（/health 将显示 degraded）");
      } else {
        logger.info({ url: config.serverUrl, status }, "复用外部 opencode serve 实例");
      }
      return config.serverUrl;
    }

    const url = localUrl();
    // 启动第一步：先看配置端口有没有被监听（TCP 层）。已有实例就直接用 client 连，不再 spawn。
    if (await isPortOpen(LOCAL_HOST, config.serverPort)) {
      reused = true;
      const status = await probeStatus(url);
      if (status === 200) {
        logger.info({ url }, "端口已有 opencode serve 在运行，复用现有实例（不由网关管理其生命周期）");
      } else if (status === 401) {
        logger.warn({ url }, "端口已有服务但鉴权不通过：OPENCODE_SERVER_PASSWORD 与该实例不一致，client 调用将 401");
      } else {
        // TCP 已开但 /api/info 不是 2.x 的响应：仍按需求直接连，便于对接反代/自定义封装；失败会在 /health 暴露。
        logger.warn(
          { url, status: status ?? "unreachable" },
          "端口已监听但 /api/info 未返回正常响应，仍按配置直接连接（若非 OpenCode 服务请更换 OPENCODE_SERVER_PORT）",
        );
      }
      return url;
    }

    // 端口空闲：按配置端口与密码拉起 `opencode serve`
    const startedUrl = await startChild();
    reused = false;
    restartDelay = RESTART_BASE_MS;
    logger.info({ url: startedUrl }, "opencode serve 已启动");
    return startedUrl;
  }

  async function stopServe() {
    stopping = true;
    if (!child) return;
    const proc = child;
    child = null;
    await new Promise((resolveStop) => {
      const killTimer = setTimeout(() => {
        terminateChild(proc, "SIGKILL");
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolveStop();
      });
      terminateChild(proc);
    });
    logger.info("opencode serve 已停止");
  }

  /** @returns {Promise<boolean>} 后端是否可达 */
  async function isHealthy() {
    if (external) return probeAlive(config.serverUrl);
    if (reused) return probeAlive(localUrl());
    if (!child) return false;
    // 子进程模式下由 SDK 健康探测负责（见 opencode-client.health），此处只看进程在不在
    return true;
  }

  /** /health 用：external=显式指定实例 / reused=探测到已有实例 / managed=网关拉起的子进程 */
  function mode() {
    if (external) return "external";
    return reused ? "reused" : "managed";
  }

  return { startServe, stopServe, isHealthy, mode, external };
}
