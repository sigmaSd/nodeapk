// The toolchain, through Vite+ (`vp`):
//   vp check   format (Oxfmt), lint (Oxlint) and type-check (TypeScript 7) — at commit (.vite-hooks/pre-commit)
//   vp lint    lint and type-check, no formatting: while editing
//   vp test    the tests (Vitest), tests/*.test.ts
//   vp pack    the CLI, one file: dist/cli.mjs (what npm ships; Node won't strip types inside node_modules)

import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 110,
    ignorePatterns: ["dist/**", "pnpm-lock.yaml", "*.md"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: { typeAware: true, typeCheck: true },
  },
  staged: { "*": "vp check --fix" },
  test: {
    include: ["tests/*.test.ts"],
  },
  pack: {
    // dist/ is one level down, like src/: the CLI finds shell/ next to it as "../shell"
    entry: { cli: "src/cli.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node24",
    clean: true,
    dts: false,
  },
});
