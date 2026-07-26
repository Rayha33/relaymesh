import { resolve } from "node:path";

export interface RelayConfig {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  adminToken?: string;
  heartbeatTimeoutMs: number;
  leaseSweepMs: number;
  leaseDurationMs: number;
  sessionTtlMs: number;
  publicUrl?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): RelayConfig {
  const dataDirectory = resolve(cwd, env.RELAYMESH_DATA_DIR ?? "./data");
  const adminToken = env.RELAYMESH_ADMIN_TOKEN?.trim();
  const config: RelayConfig = {
    host: env.RELAYMESH_HOST ?? "127.0.0.1",
    port: parseInteger(env.RELAYMESH_PORT, 4317, "RELAYMESH_PORT"),
    dataDirectory,
    databasePath: resolve(
      cwd,
      env.RELAYMESH_DATABASE_PATH ?? `${dataDirectory}/relaymesh.sqlite`,
    ),
    heartbeatTimeoutMs: parseInteger(
      env.RELAYMESH_HEARTBEAT_TIMEOUT_MS,
      30_000,
      "RELAYMESH_HEARTBEAT_TIMEOUT_MS",
    ),
    leaseSweepMs: parseInteger(
      env.RELAYMESH_LEASE_SWEEP_MS,
      5_000,
      "RELAYMESH_LEASE_SWEEP_MS",
    ),
    leaseDurationMs: parseInteger(
      env.RELAYMESH_LEASE_DURATION_MS,
      45_000,
      "RELAYMESH_LEASE_DURATION_MS",
    ),
    sessionTtlMs: parseInteger(
      env.RELAYMESH_SESSION_TTL_MS,
      12 * 60 * 60 * 1_000,
      "RELAYMESH_SESSION_TTL_MS",
    ),
  };
  if (adminToken !== undefined && adminToken.length > 0) {
    config.adminToken = adminToken;
  }
  const publicUrl = env.RELAYMESH_PUBLIC_URL?.trim();
  if (publicUrl !== undefined && publicUrl.length > 0) {
    const parsed = new URL(publicUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("RELAYMESH_PUBLIC_URL must use HTTP or HTTPS");
    }
    config.publicUrl = parsed.origin;
  }
  return config;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
