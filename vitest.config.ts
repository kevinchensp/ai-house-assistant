import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@ai-house-assistant/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url))
    }
  }
});
