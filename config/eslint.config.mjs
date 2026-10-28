// Compliance checks for this project's .mjs sources (see the "JS code standards" section of AGENTS.md).
// Division of labour: only rules an AST can decide live here; anything undecidable
// (single config source, generated payload fields) stays guarded by tests and docs, never duplicated in lint.
import js from "@eslint/js";
import globals from "globals";

const SOURCES = ["src/**/*.mjs", "scripts/**/*.mjs", "tests/**/*.mjs"];

export default [
  {
    // build output / third-party / non-JS assets are not checked
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
      // no silent silencing via eslint-disable: an unused directive is an error too
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // -- L2 syntax and style (the machine-decidable part of AGENTS.md "JS code standards") --
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
      // Node ESM: relative import/export specifiers must carry the .mjs extension (otherwise ERR_MODULE_NOT_FOUND)
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
    // -- L1 layering: core is the mechanism layer and must not depend back on api / tools (direction: api -> core) --
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
