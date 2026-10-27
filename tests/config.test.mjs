// 配置层单测：环境变量布尔陷阱 / 配置文件默认值 / 正则编译失败启动即炸（AGENTS.md §5）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadDotEnv } from "../src/config.mjs";

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

test("配置文件：正则编译 + 别名小写化 + 非法正则启动即炸", () => {
  const yaml = [
    "models:",
    "  auto:",
    '    regex: ["^(opencode/).*"]',
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
    assert.equal(config.auto.regex.length, 1);
    assert.ok(config.auto.regex[0].test("opencode/flint-40b-free"));
    assert.deepEqual(config.auto.exclude, ["opencode/gpt-5-free"]);
    assert.equal(config.auto.fallback, "opencode/flint-40b-free");
    assert.equal(config.modelAliases["flint"], "opencode/flint-40b-free");
    assert.equal(config.ollamaAliases["qwen"], "ollama/qwen3:4b");
    assert.equal(config.webSearch.model, "opencode/flint-40b-free");
    assert.equal(config.webSearch.synthesizeDefault, true);
  });

  withConfigFile("models:\n  auto:\n    regex: [\"[\"]\n", (path) => {
    assert.throws(() => loadConfig({ CONFIG_PATH: path }), /不是合法的正则表达式/);
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
    assert.throws(() => loadConfig({ CONFIG_PATH: path }), /不是合法 YAML/);
  });
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
