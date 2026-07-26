import { build } from "esbuild";

await build({
  entryPoints: {
    index: "src/mcp/index.ts",
    http: "src/mcp/http.ts",
  },
  outdir: "dist/server/src/mcp",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
});
