import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // `_` プレフィックスの引数 / 変数 / catch 引数は意図的未使用として扱う(TypeScript 慣例)。
      // 例: stub provider(Google 全 3 メソッド、OpenAI analyze/generateInterview)の `_input`/`_mode`、
      // `assembleInterviewResult` の `_usage`、`validateInterviewOutput` の `_input` 等。
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
