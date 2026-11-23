// The toolchain, through Vite+ (`vp`):
//   vp check   format (Oxfmt), lint (Oxlint) and type-check (TypeScript 7) — at commit (.vite-hooks/pre-commit)
//   vp lint    lint and type-check, no formatting: while editing
//   vp test    the tests (Vitest), tests/*.test.ts

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
});
