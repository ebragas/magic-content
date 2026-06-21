import { defineConfig, configDefaults } from "vitest/config";

// Keep the default test discovery (lib/core + app tests resolve .js→.ts via Vite),
// but never descend into `.claude/` — git worktrees created there (e.g. by
// /code-review) contain their own copies of the suite and would run twice and
// confuse `npm test`. data/ and build output are excluded too.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**", "data/**", ".next/**"],
  },
});
