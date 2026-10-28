// Process/service layer: launches and manages the `opencode serve` child process, or reuses an external instance.
// design.md §5.1: startServe / stopServe / isHealthy, automatic restart on exit (with backoff).
import { spawn } from "node:child_process";
import { connect } from "node:net";

const START_TIMEOUT_MS = 30000;
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const HEALTH_TIMEOUT_MS = 5000;
const PORT_PROBE_TIMEOUT_MS = 1000;
const LOCAL_HOST = "127.0.0.1";

/**
 * TCP probe for whether a port is already listening (port only, no protocol detection).
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

  /** Local backend address (port comes from OPENCODE_SERVER_PORT) */
  function localUrl() {
    return `http://${LOCAL_HOST}:${config.serverPort}`;
  }

  /**
   * Probe /api/info on the given address (2.x info endpoint).
   * @returns {Promise<number|null>} HTTP status code; null when unreachable (not listening / not an HTTP service)
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

  /** External instance / reused instance: health probe only (a 401 still means the process is alive) */
  function probeAlive(url) {
    return probeStatus(url).then((status) => status !== null && status < 500);
  }

  /**
   * Start `opencode serve`.
   * On Windows, a global npm install provides the `opencode.cmd` shim, which Node's spawn cannot execute directly,
   * so launch it explicitly through `cmd.exe /c`; the arguments contain only a fixed host and a numeric port, no user-controlled strings.
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

  /** Terminate the child process; on Windows the cmd shim forks opencode again, so the whole process tree must be killed or the port stays bound */
  function terminateChild(proc, signal = "SIGTERM") {
    if (!proc.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      // Environments without taskkill (rare): fall back to killing only the outer process, at least so the exit event fires as expected
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
        rejectStart(new Error(`opencode serve startup timed out (${START_TIMEOUT_MS}ms): ${output.slice(-2000)}`));
      }, START_TIMEOUT_MS);

      const onData = (chunk) => {
        const text = chunk.toString();
        output += text;
        if (settled) return;
        // Startup marker: 2.x prints "server listening on http://...", 1.x prints "opencode server listening on ..."
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
        rejectStart(new Error(`cannot execute the opencode CLI (make sure it is installed and on PATH): ${error.message}`));
      });

      proc.on("exit", (code, signal) => {
        clearTimeout(timer);
        child = null;
        if (!settled) {
          settled = true;
          rejectStart(new Error(`opencode serve exited immediately (code=${code} signal=${signal}): ${output.slice(-2000)}`));
          return;
        }
        if (stopping) return;
        // Unexpected exit → backoff restart (design.md §5.1)
        logger.error({ code, signal }, "opencode serve exited unexpectedly, scheduling automatic restart");
        const delay = restartDelay;
        restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
        setTimeout(() => {
          if (stopping) return;
          startChild().catch((error) => {
            logger.error({ err: error }, "failed to restart opencode serve");
          });
        }, delay);
      });
    });
  }

  async function startServe() {
    if (external) {
      const status = await probeStatus(config.serverUrl);
      if (status === null) {
        logger.warn({ url: config.serverUrl }, "external opencode serve is currently unreachable; gateway still connects per config (/health will show degraded)");
      } else {
        logger.info({ url: config.serverUrl, status }, "reusing external opencode serve instance");
      }
      return config.serverUrl;
    }

    const url = localUrl();
    // First startup step: check whether the configured port is listening (TCP layer). If an instance already exists, connect to it with the client instead of spawning.
    if (await isPortOpen(LOCAL_HOST, config.serverPort)) {
      reused = true;
      const status = await probeStatus(url);
      if (status === 200) {
        logger.info({ url }, "port already has a running opencode serve, reusing existing instance (its lifecycle is not managed by the gateway)");
      } else if (status === 401) {
        logger.warn({ url }, "port has a service but authentication failed: OPENCODE_SERVER_PASSWORD does not match that instance, client calls will get 401");
      } else {
        // TCP is open but /api/info is not a 2.x response: still connect as configured, to support reverse proxies/custom wrappers; failures surface in /health.
        logger.warn(
          { url, status: status ?? "unreachable" },
          "port is listening but /api/info did not return a valid response, connecting as configured anyway (change OPENCODE_SERVER_PORT if this is not an OpenCode service)",
        );
      }
      return url;
    }

    // Port is free: launch `opencode serve` on the configured port with the configured password
    const startedUrl = await startChild();
    reused = false;
    restartDelay = RESTART_BASE_MS;
    logger.info({ url: startedUrl }, "opencode serve started");
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
    logger.info("opencode serve stopped");
  }

  /** @returns {Promise<boolean>} whether the backend is reachable */
  async function isHealthy() {
    if (external) return probeAlive(config.serverUrl);
    if (reused) return probeAlive(localUrl());
    if (!child) return false;
    // In child-process mode the SDK health probe is authoritative (see opencode-client.health); here we only check the process exists
    return true;
  }

  /** For /health: external=explicitly configured instance / reused=existing instance detected / managed=child process launched by the gateway */
  function mode() {
    if (external) return "external";
    return reused ? "reused" : "managed";
  }

  return { startServe, stopServe, isHealthy, mode, external };
}
