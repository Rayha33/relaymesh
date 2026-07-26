import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type RelayApp } from "./app.js";

const apps: Array<{ relay: RelayApp; directory: string }> = [];

afterEach(async () => {
  for (const item of apps.splice(0)) {
    await item.relay.app.close();
    item.relay.runtime.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function setup(): Promise<RelayApp> {
  const directory = mkdtempSync(join(tmpdir(), "relaymesh-server-"));
  const relay = await buildApp({
    host: "127.0.0.1",
    port: 4317,
    dataDirectory: directory,
    databasePath: join(directory, "relaymesh.sqlite"),
    adminToken: "integration-admin-token",
    heartbeatTimeoutMs: 5_000,
    leaseSweepMs: 1_000,
    leaseDurationMs: 5_000,
    sessionTtlMs: 60_000,
  });
  apps.push({ relay, directory });
  return relay;
}

describe("RelayMesh HTTP API", () => {
  it("runs the agent join, claim, checkpoint, and completion flow", async () => {
    const { app } = await setup();
    const adminHeaders = { authorization: "Bearer integration-admin-token" };

    const agentResponse = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: adminHeaders,
      payload: {
        name: "Codex",
        provider: "OpenAI",
        defaultModel: "gpt-5.6",
        description: "Builder",
      },
    });
    expect(agentResponse.statusCode).toBe(201);
    const registration = agentResponse.json<{
      agent: { id: string };
      agentKey: string;
    }>();

    const missionResponse = await app.inject({
      method: "POST",
      url: "/api/v1/missions",
      headers: adminHeaders,
      payload: { title: "API flow", objective: "Complete through the API." },
    });
    const mission = missionResponse.json<{ id: string }>();

    const taskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${mission.id}/tasks`,
      headers: adminHeaders,
      payload: {
        title: "Implement",
        description: "Do the work.",
        parentTaskId: null,
        priority: 1,
        requiredCapabilities: ["code.typescript"],
        dependencies: [],
        assignedRole: null,
        maxAttempts: 3,
      },
    });
    const task = taskResponse.json<{ id: string }>();

    const joinResponse = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${mission.id}/sessions`,
      headers: {
        "x-agent-id": registration.agent.id,
        "x-agent-key": registration.agentKey,
        "idempotency-key": "api-join",
      },
      payload: {
        model: "gpt-5.6",
        role: "builder",
        capabilities: ["code.typescript"],
        recoveryFromSessionId: null,
      },
    });
    expect(joinResponse.statusCode).toBe(201);
    const joined = joinResponse.json<{
      session: { id: string };
      sessionToken: string;
    }>();
    const sessionHeaders = {
      authorization: `Bearer ${joined.sessionToken}`,
    };

    const claimResponse = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${mission.id}/tasks/claim`,
      headers: { ...sessionHeaders, "idempotency-key": "api-claim" },
    });
    expect(claimResponse.statusCode).toBe(200);
    const claim = claimResponse.json<{
      lease: { id: string; fencingToken: number };
    }>();

    const checkpointResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/checkpoints`,
      headers: { ...sessionHeaders, "idempotency-key": "api-checkpoint" },
      payload: {
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        summary: "Implementation complete.",
        nextAction: "Run checks.",
        decisions: [],
        artifactIds: [],
        opaqueState: null,
      },
    });
    expect(checkpointResponse.statusCode).toBe(201);

    const completeResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/complete`,
      headers: { ...sessionHeaders, "idempotency-key": "api-complete" },
      payload: {
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        result: { passed: true },
      },
    });
    expect(completeResponse.statusCode).toBe(200);
    expect(completeResponse.json<{ status: string }>().status).toBe("completed");

    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v1/missions/${mission.id}`,
      headers: adminHeaders,
    });
    expect(snapshot.json<{ mission: { status: string } }>().mission.status).toBe(
      "completed",
    );
    const result = await app.inject({
      method: "GET",
      url: `/api/v1/missions/${mission.id}/result`,
      headers: adminHeaders,
    });
    expect(result.json()).toMatchObject({
      ready: true,
      progress: { total: 1, completed: 1, percent: 100 },
      finalOutputs: [{ task: { id: task.id, result: { passed: true } } }],
      integrity: { valid: true },
    });
  });

  it("rejects missing admin auth and cross-session paths", async () => {
    const { app } = await setup();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/overview",
        })
      ).statusCode,
    ).toBe(401);
    const discovery = (
      await app.inject({
        method: "GET",
        url: "/.well-known/relaymesh.json",
      })
    ).json<{ protocol: string; primitives: string[] }>();
    expect(discovery.protocol).toBe("relaymesh/2");
    expect(discovery.primitives).toContain("sync-envelopes");
    expect(discovery.primitives).toContain("atomic-handoff");
    expect(discovery.primitives).toContain("checkpoints");
    expect(discovery.primitives).toContain("recovery");
    const tools = (
      await app.inject({
        method: "GET",
        url: "/.well-known/relaymesh-tools.json",
      })
    ).json<{ tools: Array<{ function: { strict: boolean } }> }>();
    expect(tools.tools).toHaveLength(11);
    expect(tools.tools.every((tool) => tool.function.strict)).toBe(true);
  });

  it("manages scoped remote MCP connection tickets without exposing stored secrets", async () => {
    const { app } = await setup();
    const headers = {
      authorization: "Bearer integration-admin-token",
    };
    const registration = (
      await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        headers,
        payload: {
          name: "ChatGPT",
          provider: "OpenAI",
          defaultModel: "chatgpt",
          description: "",
        },
      })
    ).json<{ agent: { id: string }; agentKey: string }>();
    const mission = (
      await app.inject({
        method: "POST",
        url: "/api/v1/missions",
        headers,
        payload: {
          title: "Scoped MCP",
          objective: "Connect a client without custom headers.",
        },
      })
    ).json<{ id: string }>();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${mission.id}/connections`,
      headers,
      payload: {
        agentId: registration.agent.id,
        model: "chatgpt",
        role: "reviewer",
        capabilities: ["general"],
        expiresInHours: 1,
      },
    });
    expect(created.statusCode).toBe(201);
    const issued = created.json<{
      connection: { id: string; status: string };
      ticket: string;
    }>();
    expect(issued.ticket).not.toContain(registration.agentKey);

    const listed = (
      await app.inject({
        method: "GET",
        url: "/api/v1/connections",
        headers,
      })
    ).json<Array<Record<string, unknown>>>();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("ticket");
    expect(listed[0]).not.toHaveProperty("token_hash");

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/connections/${issued.connection.id}/revoke`,
      headers,
    });
    expect(revoked.json<{ status: string }>().status).toBe("revoked");
  });
});
