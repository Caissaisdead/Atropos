import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  target: "node20",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  banner: ({ format }) =>
    format === "cjs"
      ? {}
      : { js: "#!/usr/bin/env node" },
});
