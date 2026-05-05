import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.ts"],
    rules: {
      // Project-tuned: prefer warnings to friction, errors only for real bugs.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // We use `void someAsync()` intentionally in a few places.
      "@typescript-eslint/no-floating-promises": "off",
      // Allow require()-style dynamic import patterns where they appear.
      "@typescript-eslint/no-require-imports": "warn",
      // Block real bugs:
      "no-await-in-loop": "off", // we genuinely sequentially await pages
      "no-fallthrough": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // Tests and scripts: a touch more permissive.
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
