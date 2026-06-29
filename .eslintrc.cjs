/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  extends: [
    "next/core-web-vitals",
    "next/typescript",
    // Keep eslint-config-prettier last so it disables stylistic rules that
    // would conflict with Prettier.
    "prettier",
  ],
  ignorePatterns: [
    "node_modules/",
    ".next/",
    "out/",
    "dist/",
    "build/",
    "coverage/",
    "data/",
    "drizzle/",
    "next-env.d.ts",
  ],
  overrides: [
    {
      // Keep styling in globals.css (token-based BEM), not inline. Inline styles
      // bypass the design tokens AND the responsive @media layer, which is what
      // caused the recurring "add a feature, break something elsewhere" churn.
      // Genuinely dynamic values (a computed width, a bound --css-var) may stay
      // inline with an `eslint-disable-next-line react/forbid-dom-props` + reason.
      files: ["src/components/**/*.tsx", "src/app/**/*.tsx"],
      excludedFiles: ["**/*.test.tsx"],
      rules: {
        "react/forbid-dom-props": [
          "warn",
          {
            forbid: [
              {
                propName: "style",
                message:
                  "Use a token-based class in globals.css — inline style bypasses the design system and media queries. If the value is truly dynamic, add an eslint-disable with a reason.",
              },
            ],
          },
        ],
        "no-restricted-syntax": [
          "warn",
          {
            selector: "Literal[value=/^-?\\d+px$/]",
            message:
              "Hardcoded px — use a --space / --radius / --text token (or a CSS class) instead.",
          },
        ],
      },
    },
  ],
};
