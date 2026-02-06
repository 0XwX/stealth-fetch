import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  ...tseslint.configs.recommended,
  jsdoc.configs["flat/recommended-typescript"],
  {
    files: ["src/**/*.ts", "test/**/*.ts", "examples/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Cloudflare Workers globals
        addEventListener: "readonly",
        caches: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        ReadableStream: "readonly",
        WritableStream: "readonly",
        TransformStream: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        performance: "readonly",
        globalThis: "readonly",
        queueMicrotask: "readonly",
      },
    },
    settings: {
      jsdoc: {
        mode: "typescript",
        tagNamePreference: {
          returns: "returns",
        },
      },
    },
    rules: {
      // JSDoc — relaxed for TS (type system already provides guarantees)
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-description": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/require-param": "off",
      "jsdoc/require-param-description": "off",

      // TypeScript
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",

      // Code quality
      "no-console": ["warn", { allow: ["warn", "error", "debug"] }],
      "no-debugger": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-throw-literal": "error",
      "prefer-const": "error",
      "no-var": "error",
      "prefer-template": "error",
      "object-shorthand": ["error", "always"],
    },
  },
  prettierConfig,
  {
    files: ["test/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    files: ["src/**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["dist/", "coverage/", "node_modules/", ".wrangler/", "src/socket/wasm-pkg/"],
  },
];
