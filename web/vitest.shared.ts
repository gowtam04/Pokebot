import tsconfigPaths from "vite-tsconfig-paths";

// Shared config consumed by every project in vitest.config.ts via
// `extends: true`. vite-tsconfig-paths makes the `@/` alias resolve in tests
// exactly as it does under tsc/next.
//
// oxc.jsx enables the React 17+ automatic JSX transform so .tsx test files
// (and .tsx source files) don't need `import React from 'react'` and Vite 8 /
// Rolldown won't error on JSX syntax.
//
// Vite 8 uses oxc for transforms (not esbuild). The correct JsxOptions shape
// is an object with `runtime: 'automatic'`; jsxImportSource defaults to
// 'react', which is correct for React 19.
export const shared = {
  plugins: [tsconfigPaths()],
  oxc: {
    jsx: { runtime: "automatic" as const },
  },
};
