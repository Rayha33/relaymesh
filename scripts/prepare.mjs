import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Git dependencies contain source and need to build before npm packs them.
// Registry tarballs already contain dist/ and intentionally omit source.
if (existsSync(resolve(packageRoot, "src"))) {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
