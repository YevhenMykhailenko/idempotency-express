import parser from "@typescript-eslint/parser";
import pluginTs from "@typescript-eslint/eslint-plugin";
import pluginImport from "eslint-plugin-import";
import globals from "globals";

export default [
  { ignores: ["dist/**", "examples/**", "coverage/**"] },

  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.node },
    },
    plugins: { "@typescript-eslint": pluginTs, import: pluginImport },
    rules: {
      ...pluginTs.configs.recommended.rules,

      "@typescript-eslint/no-explicit-any": ["error", {
        fixToUnknown: true,
        ignoreRestArgs: true
      }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

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
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
