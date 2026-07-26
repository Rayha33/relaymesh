import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type RelayApp } from "../server/app.js";

interface Fixture {
  relay: RelayApp;
  directory: string;
  baseUrl: string;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.relay.app.close();
    fixture.relay.runtime.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("RelayMesh A2A v1.0 binding", () => {
  it("discovers, synchronizes, scopes, lists, and cancels durable tasks", async () => {
    const fixture = await setup();
    const { runtime } = fixture.relay;
    const registration = runtime.createAgent({
      name: "A2A universal agent",
      provider: "provider-neutral",
      defaultModel: "any-model",
      description: "",
    });
    const mission = runtime.createMission({
      title: "A2A mission",
      objective: "Coordinate through a standard agent protocol.",
    });
    const task = runtime.createTask(mission.id, {
      title: "Portable A2A work",
      description: "Return one RelayMesh sync envelope.",
      parentTaskId: null,
      priority: 10,
      requiredCapabilities: ["general"],
      dependencies: [],
      assignedRole: "worker",
      maxAttempts: 3,
    });
    const otherMission = runtime.createMission({
      title: "Private mission",
      objective: "Stay outside the A2A ticket scope.",
    });
    const privateTask = runtime.createTask(otherMission.id, {
      title: "Private task",
      description: "Must not be visible.",
      parentTaskId: null,
      priority: 1,
      requiredCapabilities: [],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });
    const issued = runtime.createConnectionTicket(mission.id, {
      agentId: registration.agent.id,
      model: "claude-or-chatgpt-or-deepseek",
      role: "worker",
      capabilities: ["general"],
      expiresInHours: 1,
    });

    const cardResponse = await fetch(
      `${fixture.baseUrl}/.well-known/agent-card.json`,
    );
    expect(cardResponse.status).toBe(200);
    const card = (await cardResponse.json()) as {
      version: string;
      supportedInterfaces: Array<{
        protocolBinding: string;
        protocolVersion: string;
      }>;
      capabilities: { streaming: boolean };
    };
    expect(card).toMatchObject({
      version: "0.5.0",
      capabilities: { streaming: false },
      supportedInterfaces: [
        {
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
        },
      ],
    });

    const wrongVersion = await fetch(
      `${fixture.baseUrl}/a2a/v1/message:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.ticket}`,
          "content-type": "application/a2a+json",
        },
        body: JSON.stringify({
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            parts: [{ text: "Synchronize" }],
          },
        }),
      },
    );
    expect(wrongVersion.status).toBe(400);
    expect(await wrongVersion.json()).toMatchObject({
      error: {
        details: [{ reason: "VERSION_NOT_SUPPORTED" }],
      },
    });

    const sent = await a2aFetch(
      fixture.baseUrl,
      issued.ticket,
      "/message:send",
      {
        method: "POST",
        body: JSON.stringify({
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            parts: [
              {
                text: "Join the mission and tell the other models I am ready.",
              },
            ],
            metadata: {
              relaymeshIntent: "inform",
              subject: "A2A agent joined",
            },
          },
        }),
      },
    );
    expect(sent.status).toBe(200);
    const sentPayload = (await sent.json()) as {
      task: {
        id: string;
        contextId: string;
        status: { state: string };
        artifacts: Array<{
          name: string;
          parts: Array<{ data: { protocol?: string } }>;
        }>;
      };
    };
    expect(sentPayload.task).toMatchObject({
      id: task.id,
      contextId: mission.id,
      status: { state: "TASK_STATE_WORKING" },
    });
    expect(
      sentPayload.task.artifacts.find(
        (artifact) => artifact.name === "relaymesh-sync-envelope.json",
      )?.parts[0]?.data.protocol,
    ).toBe("relaymesh/2");
    expect(
      runtime.listConnectionTickets()[0]?.lastSessionId,
    ).not.toBeNull();

    const listed = await a2aFetch(
      fixture.baseUrl,
      issued.ticket,
      "/tasks",
    );
    expect(await listed.json()).toMatchObject({
      tasks: [{ id: task.id, contextId: mission.id }],
      totalSize: 1,
      pageSize: 1,
      nextPageToken: "",
    });

    const hidden = await a2aFetch(
      fixture.baseUrl,
      issued.ticket,
      `/tasks/${privateTask.id}`,
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({
      error: { details: [{ reason: "TASK_NOT_FOUND" }] },
    });

    const cancelled = await a2aFetch(
      fixture.baseUrl,
      issued.ticket,
      `/tasks/${task.id}:cancel`,
      { method: "POST" },
    );
    expect(await cancelled.json()).toMatchObject({
      task: {
        id: task.id,
        status: { state: "TASK_STATE_CANCELED" },
      },
    });
    expect(runtime.getTask(task.id).status).toBe("cancelled");
    const cancelledAgain = await a2aFetch(
      fixture.baseUrl,
      issued.ticket,
      `/tasks/${task.id}:cancel`,
      { method: "POST" },
    );
    expect(cancelledAgain.status).toBe(200);
    expect(await cancelledAgain.json()).toMatchObject({
      task: { id: task.id, status: { state: "TASK_STATE_CANCELED" } },
    });
  });
});

async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "relaymesh-a2a-"));
  const relay = await buildApp({
    host: "127.0.0.1",
    port: 4317,
    dataDirectory: directory,
    databasePath: join(directory, "relaymesh.sqlite"),
    adminToken: "a2a-admin-token",
    heartbeatTimeoutMs: 1_000,
    leaseSweepMs: 1_000,
    leaseDurationMs: 5_000,
    sessionTtlMs: 60_000,
    roleReservationMs: 900_000,
  });
  await relay.app.listen({ host: "127.0.0.1", port: 0 });
  const address = relay.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("RelayMesh did not expose a TCP test address");
  }
  const fixture = {
    relay,
    directory,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
  fixtures.push(fixture);
  return fixture;
}

function a2aFetch(
  baseUrl: string,
  ticket: string,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ticket}`);
  headers.set("a2a-version", "1.0");
  headers.set(
    "a2a-extensions",
    "https://github.com/Rayha33/relaymesh/blob/main/docs/PROTOCOL.md#relaymesh-a2a-extension-v1",
  );
  if (init.body !== undefined) {
    headers.set("content-type", "application/a2a+json");
  }
  return fetch(`${baseUrl}/a2a/v1${path}`, { ...init, headers });
}
