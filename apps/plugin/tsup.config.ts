import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // yaml ships CommonJS and calls require("process"); provide a real require
  // so the bundled CJS can run from the ESM output.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // The published plugin must be standalone: bundle the private workspace
  // package and its runtime dependencies so no workspace dependency is needed
  // after install.
  noExternal: ["@skills-hub/protocol", "yaml", "zod"],
})
