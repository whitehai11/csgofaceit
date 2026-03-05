const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const security = require("eslint-plugin-security");

module.exports = [
  {
    ignores: ["dist/**", "node_modules/**"]
  },
  {
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module"
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...security.configs.recommended.rules,
      "no-eval": "error",
      "no-implied-eval": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-child-process": "error",
      "security/detect-unsafe-regex": "warn",
      "security/detect-non-literal-require": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
];
