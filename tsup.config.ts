import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "acp/index": "src/acp/index.ts",
    "bot/index": "src/bot/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: true,
});
