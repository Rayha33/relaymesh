import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspace = process.cwd();
const temporaryDirectory = mkdtempSync(join(tmpdir(), "relaymesh-package-"));

try {
  const manifest = JSON.parse(
    readFileSync(join(workspace, "package.json"), "utf8"),
  );
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("package.json must contain a name and version");
  }
  run("npm", ["pack", "--pack-destination", temporaryDirectory], workspace);
  const filename = `${manifest.name
    .replace(/^@/, "")
    .replace("/", "-")}-${manifest.version}.tgz`;
  const tarball = join(temporaryDirectory, filename);
  const installation = join(temporaryDirectory, "consumer");
  mkdirSync(installation, { recursive: true });
  writeFileSync(
    join(installation, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  run(
    "npm",
    [
      "install",
      "--dangerously-allow-all-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    installation,
  );

  const packageRoot = join(installation, "node_modules", "relaymesh");
  for (const path of [
    "dist/server/src/cli/index.js",
    "dist/server/src/a2a/index.js",
    "dist/server/src/mcp/http.js",
    "dist/server/src/mcp/index.js",
    "dist/server/src/sdk/index.js",
    "dist/web/index.html",
  ]) {
    if (!existsSync(join(packageRoot, path))) {
      throw new Error(`Packed artifact is missing ${path}`);
    }
  }
  const mcpEntry = readFileSync(
    join(packageRoot, "dist/server/src/mcp/index.js"),
    "utf8",
  );
  if (!mcpEntry.startsWith("#!/usr/bin/env node")) {
    throw new Error("Packed MCP executable is missing its shebang");
  }

  run(
    "node",
    [
      "--input-type=module",
      "--eval",
      "import { RelayAgentClient, executeRelayFunction, relayFunctionTools } from 'relaymesh'; if (typeof RelayAgentClient !== 'function' || typeof executeRelayFunction !== 'function' || relayFunctionTools.length !== 11) process.exit(1)",
    ],
    installation,
  );
  const help = run(
    "node",
    ["node_modules/relaymesh/dist/server/src/cli/index.js", "--help"],
    installation,
  );
  if (
    !help.includes("  demo\n") ||
    !help.includes("  worker:openai\n") ||
    !help.includes("  mission:result --mission ID\n") ||
    !help.includes("  relaymesh <command>")
  ) {
    throw new Error("Packed CLI help is incomplete");
  }
  run("npm", ["audit", "--audit-level=moderate"], installation);
  process.stdout.write("Packed consumer install verified with zero vulnerabilities.\n");
} finally {
  rmSync(resolve(temporaryDirectory), { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}
