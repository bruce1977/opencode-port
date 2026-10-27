// 启动清单：把 resolver.listAll() 的结果整理成终端可读文本。
// 只做展示，不参与模型解析；解析规则仍以 core/model-resolver.mjs 为准（api.md §7）。
const BUILTIN_PROVIDER = "opencode";

/** @param {{ providerID?: string } | null | undefined} entry */
function providerOf(entry) {
  return entry?.providerID || "unknown";
}

/** @param {string} providerID */
function providerLabel(providerID) {
  if (providerID === BUILTIN_PROVIDER) return "内置";
  if (providerID === "unknown") return "未知";
  return "自定义";
}

/** @param {{ providerID?: string, modelID?: string, name?: string, info?: { name?: string } }} entry */
function modelLine(entry) {
  const fullName = entry.name || `${providerOf(entry)}/${entry.modelID ?? ""}`;
  const displayName = entry.info?.name;
  if (!displayName || displayName === entry.modelID) return fullName;
  return `${fullName}  ${displayName}`;
}

/**
 * 生成可用模型清单（纯函数，便于测试）。
 * @param {{ builtins?: Array<object>, ollama?: Array<object> }} [catalogue]
 * @returns {string} 不含结尾换行的多行文本
 */
export function formatModelCatalogue(catalogue = {}) {
  const entries = [...(catalogue.builtins ?? []), ...(catalogue.ollama ?? [])];
  const groups = new Map();
  for (const entry of entries) {
    const provider = providerOf(entry);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(entry);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  }
  // 内置 provider 排在最前，其余按名称排序，便于一眼看清本机自定义模型
  const providers = [...groups.keys()].sort((a, b) => {
    if (a === BUILTIN_PROVIDER) return -1;
    if (b === BUILTIN_PROVIDER) return 1;
    return a.localeCompare(b);
  });

  const lines = [
    `可用模型：后端 ${entries.length} 个（${providers.length} 个 provider）+ 虚拟模型 auto`,
  ];
  if (entries.length === 0) {
    lines.push("  （后端未返回可用模型：检查 opencode 登录态 / provider 配置）");
  }
  for (const provider of providers) {
    const list = groups.get(provider);
    lines.push(`  ${providerLabel(provider)} · ${provider}（${list.length} 个）`);
    for (const entry of list) lines.push(`    - ${modelLine(entry)}`);
  }
  lines.push("  虚拟 · auto（按 config.yaml 的 models.auto.regex 从内置模型随机选择）");
  return lines.join("\n");
}

/**
 * 输出模型清单到指定流（默认 stdout；面向终端，不是结构化日志）。
 * @param {NodeJS.WritableStream} stream
 * @param {{ builtins?: Array<object>, ollama?: Array<object> }} catalogue
 * @returns {string} 实际写入的文本
 */
export function writeModelCatalogue(stream, catalogue) {
  const text = formatModelCatalogue(catalogue);
  stream.write(`${text}\n`);
  return text;
}
