// 本项目 .mjs 源码的合规检查（规范正文见 AGENTS.md「JS 代码规范」）。
// 分工：这里只放「AST 能判定」的规则；配置单源、产物字段这类判不出来的，
// 由测试与文档守，不在 lint 里重复实现（两处都能改同一件事 = 互相掩盖）。
import js from "@eslint/js";
import globals from "globals";

const SOURCES = ["src/**/*.mjs", "scripts/**/*.mjs", "tests/**/*.mjs"];

export default [
  {
    // 生成物 / 第三方 / 非 JS 资源不参与检查
    ignores: [
      "node_modules/**",
      "coverage/**",
      "output/**",
      "logs/**",
      ".temp/**",
      ".opencode/**",
      "docs/**",
      "config/**",
    ],
  },
  js.configs.recommended,
  {
    files: SOURCES,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: {
      // 禁止用 eslint-disable 悄悄消音：禁用了没生效同样报错
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // —— L2 语法与风格（AGENTS.md「JS 代码规范」的机器可判定部分）——
      indent: ["error", 2, { SwitchCase: 1 }],
      quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
      semi: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": ["error", { args: "after-used", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-undef": "error",
      "no-shadow": "error",
      "no-await-in-loop": "off",
      // Node ESM：相对 import/export 必须带 .mjs 扩展名（漏了就 ERR_MODULE_NOT_FOUND）
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.mjs$/])",
          message: "相对 import 必须带 .mjs 扩展名（Node ESM 无扩展名解析不到）。",
        },
        {
          selector:
            "ExportNamedDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.mjs$/])",
          message: "相对 export 必须带 .mjs 扩展名（Node ESM 无扩展名解析不到）。",
        },
        {
          selector: "ExportAllDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.mjs$/])",
          message: "相对 export * 必须带 .mjs 扩展名（Node ESM 无扩展名解析不到）。",
        },
      ],
    },
  },
  {
    // —— L1 分层：core 是机制层，不得反向依赖 api / tools（依赖方向 api → core）——
    files: ["src/core/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/api", "**/api/*", "**/tools", "**/tools/*"],
              message: "依赖方向只允许 api/tools → core（AGENTS.md：core 不得 import api / tools）。",
            },
          ],
        },
      ],
    },
  },
];
