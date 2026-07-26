import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("server configuration", () => {
  it("uses local-only, durable defaults", () => {
    const cwd = "/tmp/relaymesh-config-default";
    expect(loadConfig({}, cwd)).toEqual({
      host: "127.0.0.1",
      port: 4317,
      dataDirectory: resolve(cwd, "./data"),
      databasePath: resolve(cwd, "./data/relaymesh.sqlite"),
      heartbeatTimeoutMs: 30_000,
      leaseSweepMs: 5_000,
      leaseDurationMs: 45_000,
      sessionTtlMs: 43_200_000,
    });
  });

  it("accepts explicit deployment settings and trims the admin token", () => {
    const cwd = "/tmp/relaymesh-config-custom";
    expect(
      loadConfig(
        {
          RELAYMESH_HOST: "0.0.0.0",
          RELAYMESH_PORT: "9000",
          RELAYMESH_DATA_DIR: "./state",
          RELAYMESH_DATABASE_PATH: "./database/runtime.sqlite",
          RELAYMESH_ADMIN_TOKEN: "  deployment-secret  ",
          RELAYMESH_HEARTBEAT_TIMEOUT_MS: "2000",
          RELAYMESH_LEASE_SWEEP_MS: "500",
          RELAYMESH_LEASE_DURATION_MS: "4000",
          RELAYMESH_SESSION_TTL_MS: "60000",
        },
        cwd,
      ),
    ).toEqual({
      host: "0.0.0.0",
      port: 9000,
      dataDirectory: resolve(cwd, "./state"),
      databasePath: resolve(cwd, "./database/runtime.sqlite"),
      adminToken: "deployment-secret",
      heartbeatTimeoutMs: 2000,
      leaseSweepMs: 500,
      leaseDurationMs: 4000,
      sessionTtlMs: 60000,
    });
  });

  it.each(["0", "-1", "abc", "9007199254740992"])(
    "rejects invalid positive integers: %s",
    (value) => {
      expect(() =>
        loadConfig({ RELAYMESH_PORT: value }, "/tmp/relaymesh-config-invalid"),
      ).toThrow(/positive integer/);
    },
  );

  it("ignores an empty admin token", () => {
    expect(
      loadConfig(
        { RELAYMESH_ADMIN_TOKEN: "   " },
        "/tmp/relaymesh-config-empty-token",
      ),
    ).not.toHaveProperty("adminToken");
  });
});
