import js from "@eslint/js";
import pluginStylistic from "@stylistic/eslint-plugin";
import pluginTs from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import eslintConfigPrettier from "eslint-config-prettier";
import pluginImport from "eslint-plugin-import";
import globals from "globals";

export default [
  { ignores: ["dist/**", "examples/**", "coverage/**"] },

  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2022 },
    },
    plugins: {
      "@typescript-eslint": pluginTs,
      "@stylistic": pluginStylistic,
      import: pluginImport,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...pluginTs.configs["flat/eslint-recommended"].rules,
      ...pluginTs.configs.recommended.rules,
      ...eslintConfigPrettier.rules,

      "@typescript-eslint/no-explicit-any": ["error", {
        fixToUnknown: true,
        ignoreRestArgs: true
      }],
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],

      // Explicit spacing policy takes precedence over Prettier's compatibility preset.
      "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxBOF: 0, maxEOF: 0 }],
      "@stylistic/padded-blocks": ["error", "never"],
      "@stylistic/lines-between-class-members": ["error", "always", {
        exceptAfterSingleLine: true,
      }],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
        { blankLine: "always", prev: "multiline-block-like", next: "*" },
        { blankLine: "always", prev: ["if", "for", "while", "switch", "try"], next: "*" },
        { blankLine: "always", prev: "*", next: ["return", "throw"] },
        { blankLine: "always", prev: "*", next: ["function", "class"] },
        { blankLine: "always", prev: ["function", "class"], next: "*" },
      ],

      "no-console": ["warn", { allow: ["warn", "error"] }],
      "import/no-unresolved": "off",
      "import/order": [
        "warn",
        {
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
          groups: [["builtin", "external"], ["internal"], ["parent", "sibling", "index"]],
        },
      ],
    },
  },

  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
];
