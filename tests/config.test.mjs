// Config-layer unit tests: boolean env-var pitfalls, config-file defaults, invalid regex failing fast at startup,
// API keys file parsing (AGENTS.md §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadDotEnv, readApiKeys } from "../src/config.mjs";

function withConfigFile(yaml, fn) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml, "utf8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("环境变量：boolish 语义（\"false\" 必须是 false，不是 truthy 字符串陷阱）", () => {
  withConfigFile("", (path) => {
    const off = loadConfig({ CONFIG_PATH: path, API_KEY_ENABLED: "false" });
    assert.equal(off.apiKeyEnabled, false);
    const on = loadConfig({ CONFIG_PATH: path, API_KEY_ENABLED: "true" });
    assert.equal(on.apiKeyEnabled, true);
    const empty = loadConfig({ CONFIG_PATH: path, API_KEY_ENABLED: "" });
    assert.equal(empty.apiKeyEnabled, false);
  });
});

test("环境变量：空串视为未设置（compose 的 ${VAR:-} 注入），非空才生效", () => {
  withConfigFile("", (path) => {
    assert.equal(loadConfig({ CONFIG_PATH: path, OPENCODE_SERVER_URL: "" }).serverUrl, "");
    const external = "http://127.0.0.1:10001";
    assert.equal(loadConfig({ CONFIG_PATH: path, OPENCODE_SERVER_URL: external }).serverUrl, external);
  });
});

test("默认值：端口 / search / session / web_search", () => {
  withConfigFile("", (path) => {
    const config = loadConfig({ CONFIG_PATH: path });
    assert.equal(config.port, 10000);
    assert.equal(config.serverPort, 10001);
    assert.equal(config.logLevel, "info");
    assert.equal(config.search.provider, "duckduckgo");
    assert.equal(config.search.topK, 5);
    assert.equal(config.search.maxCharsPerPage, 4000);
    assert.equal(config.sessionTtlMin, 30);
    assert.equal(config.webSearch.model, "");
    assert.equal(config.webSearch.synthesizeDefault, false);
  });
});

test("非法 LOG_LEVEL 报错（zod 枚举）", () => {
  withConfigFile("", (path) => {
    assert.throws(() => loadConfig({ CONFIG_PATH: path, LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
  });
});

test("配置文件：allow 正则编译（大小写不敏感）+ 别名小写化 + 非法正则启动即炸", () => {
  const yaml = [
    "models:",
    "  allow:",
    '    - "^(opencode/).*"',
    "  auto:",
    "    exclude: [\"OpenCode/GPT-5-Free\"]",
    '    fallback: "opencode/flint-40b-free"',
    "  aliases:",
    '    FLINT: "opencode/flint-40b-free"',
    "ollama:",
    "  aliases:",
    '    Qwen: "ollama/qwen3:4b"',
    "web_search:",
    '  model: "opencode/flint-40b-free"',
    "  synthesize_default: true",
  ].join("\n");
  withConfigFile(yaml, (path) => {
    const config = loadConfig({ CONFIG_PATH: path });
    assert.deepEqual(config.allow.sources, ["^(opencode/).*"]);
    assert.equal(config.allow.regex.length, 1);
    assert.ok(config.allow.regex[0].test("opencode/flint-40b-free"));
    assert.ok(config.allow.regex[0].test("OPENCODE/GLM-4.6-FREE"));
    assert.deepEqual(config.auto.exclude, ["opencode/gpt-5-free"]);
    assert.equal(config.auto.fallback, "opencode/flint-40b-free");
    assert.equal(config.modelAliases["flint"], "opencode/flint-40b-free");
    assert.equal(config.ollamaAliases["qwen"], "ollama/qwen3:4b");
    assert.equal(config.webSearch.model, "opencode/flint-40b-free");
    assert.equal(config.webSearch.synthesizeDefault, true);
  });

  withConfigFile("models:\n  allow: [\"[\"]\n", (path) => {
    assert.throws(() => loadConfig({ CONFIG_PATH: path }), /is not a valid regular expression/);
  });
});

test("默认值：models.allow 为空表示不过滤，auto.exclude / fallback 为空", () => {
  withConfigFile("", (path) => {
    const config = loadConfig({ CONFIG_PATH: path });
    assert.deepEqual(config.allow.sources, []);
    assert.equal(config.allow.regex.length, 0);
    assert.deepEqual(config.auto.exclude, []);
    assert.equal(config.auto.fallback, "");
  });
});

test("配置文件缺失：全部走默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  try {
    const config = loadConfig({ CONFIG_PATH: join(dir, "absent.yaml") });
    assert.equal(config.search.topK, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置文件非法 YAML：报错信息含路径与原因", () => {
  withConfigFile("models: [\n", (path) => {
    assert.throws(() => loadConfig({ CONFIG_PATH: path }), /is not valid YAML/);
  });
});

test("API keys 文件：一行一个，忽略空行与 # 注释、去重、保留顺序", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  const path = join(dir, ".keys");
  writeFileSync(path, "\uFEFF# gateway keys\n\n  sk-alice  \nsk-bob\nsk-alice\n\r\nsk-carol\n", "utf8");
  try {
    assert.deepEqual(readApiKeys(path), ["sk-alice", "sk-bob", "sk-carol"]);
    const config = loadConfig({ CONFIG_PATH: join(dir, "config.yaml"), API_KEYS_FILE: path });
    assert.deepEqual(config.apiKeys, ["sk-alice", "sk-bob", "sk-carol"]);
    // apiKey 取第一个：每分钟自测用它访问自己的 /health
    assert.equal(config.apiKey, "sk-alice");
    assert.equal(config.apiKeysFileFound, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API keys 文件缺失：不报错，只用 API_KEY 环境变量", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  try {
    assert.deepEqual(readApiKeys(join(dir, "absent.keys")), []);
    const config = loadConfig({
      CONFIG_PATH: join(dir, "config.yaml"),
      API_KEYS_FILE: join(dir, "absent.keys"),
      API_KEY: "from-env",
    });
    assert.deepEqual(config.apiKeys, ["from-env"]);
    assert.equal(config.apiKey, "from-env");
    // 启动日志靠这个标志区分「文件没找到」和「文件里没 key」
    assert.equal(config.apiKeysFileFound, false);
    const empty = loadConfig({ CONFIG_PATH: join(dir, "config.yaml"), API_KEYS_FILE: join(dir, "absent.keys") });
    assert.deepEqual(empty.apiKeys, []);
    assert.equal(empty.apiKeysFileFound, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API_KEY 与 keys 文件同时存在：环境变量优先且不重复", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  const path = join(dir, ".keys");
  writeFileSync(path, "sk-bob\nsk-shared\n", "utf8");
  try {
    const config = loadConfig({
      CONFIG_PATH: join(dir, "config.yaml"),
      API_KEYS_FILE: path,
      API_KEY: "sk-shared",
    });
    assert.deepEqual(config.apiKeys, ["sk-shared", "sk-bob"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API keys 文件读不了：启动即失败并说明是哪个文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  try {
    // 目录当文件读 → EISDIR（不是 ENOENT，不能静默当成「没有 key」）
    assert.throws(() => readApiKeys(dir), /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv：注释/空行/export/引号解析，真实环境变量优先，缺失文件静默跳过", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-port-"));
  const path = join(dir, ".env");
  writeFileSync(
    path,
    [
      "# 注释",
      "",
      "FOO=from-file",
      "export BAR='quoted value'",
      'BAZ="double quoted"',
      "EMPTY=",
      "NO_EQUALS",
    ].join("\n"),
    "utf8",
  );
  const env = { FOO: "from-real-env" };
  try {
    assert.equal(loadDotEnv(path, env), true);
    assert.equal(env.FOO, "from-real-env");
    assert.equal(env.BAR, "quoted value");
    assert.equal(env.BAZ, "double quoted");
    assert.equal(env.EMPTY, "");
    assert.equal(env.NO_EQUALS, undefined);
    assert.equal(loadDotEnv(join(dir, "absent.env"), env), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
