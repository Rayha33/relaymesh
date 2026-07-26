import { build } from "esbuild";

await build({
  entryPoints: ["src/mcp/index.ts"],
  outfile: "dist/server/src/mcp/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
});
