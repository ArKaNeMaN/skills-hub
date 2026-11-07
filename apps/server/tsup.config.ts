import { defineConfig } from "tsup"

export default defineConfig({
  entry: { main: "src/main.ts", cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // The private workspace protocol package (and its yaml dependency) is
  // bundled; everything in dependencies stays external and is installed with
  // the server package.
  noExternal: ["@skills-hub/protocol", "yaml"],
  external: ["fastify", "@fastify/static", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod"],
  // tsup strips the node: prefix by default, but `sqlite` only resolves as
  // `node:sqlite`.
  removeNodeProtocol: false,
})
