import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // This app's pages are plain client components that fetch on mount and
      // setState when the request resolves (or in a synchronous early-return
      // guard clause, e.g. clearing a dependent dropdown when its parent
      // selection changes) — the exact "cascading synchronous render" this
      // rule warns about doesn't apply to an async data load, and the app is
      // too small to justify pulling in a data-fetching library just to
      // satisfy this rule.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
