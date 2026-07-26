import { describe, expect, it } from "vitest";
import { RelayAgentClient, RelayApiError } from "./client.js";

const sessionIdentity = {
  id: "00000000-0000-4000-8000-000000000001",
  missionId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  agentName: "SDK Worker",
  provider: "Independent",
  model: "portable-model",
  role: "worker",
  capabilities: ["general"],
  status: "active" as const,
  joinedAt: "2026-07-26T12:00:00.000Z",
  lastHeartbeatAt: "2026-07-26T12:00:00.000Z",
  expiresAt: "2026-07-26T13:00:00.000Z",
  recoveryFromSessionId: null,
};

describe("RelayMesh TypeScript SDK", () => {
  it("preserves custom transports and caller-supplied idempotency keys", async () => {
    const requests: Array<{ url: string; idempotencyKey: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push({
        url,
        idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      });
      if (url.endsWith("/sessions")) {
        return jsonResponse({
          session: sessionIdentity,
          sessionToken: "signed-session-token",
          snapshot: {
            mission: {
              id: sessionIdentity.missionId,
              title: "SDK mission",
              objective: "Verify transport propagation.",
              status: "active",
              createdAt: sessionIdentity.joinedAt,
              updatedAt: sessionIdentity.joinedAt,
            },
            sessions: [sessionIdentity],
            tasks: [],
            messages: [],
            artifacts: [],
            eventSequence: 1,
          },
        });
      }
      if (url.endsWith("/heartbeat")) {
        return jsonResponse({
          sessionId: sessionIdentity.id,
          heartbeatAt: sessionIdentity.lastHeartbeatAt,
          nextHeartbeatDueAt: "2026-07-26T12:00:15.000Z",
          inboxCount: 0,
          renewedLeases: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const agent = new RelayAgentClient(
      sessionIdentity.agentId,
      "agent-secret",
      {
        baseUrl: "http://relaymesh.test/",
        fetch: fetcher,
      },
    );
    const { session } = await agent.join(
      sessionIdentity.missionId,
      {
        model: sessionIdentity.model,
        role: sessionIdentity.role,
        capabilities: sessionIdentity.capabilities,
        recoveryFromSessionId: null,
      },
      { idempotencyKey: "stable-join-key" },
    );
    await session.heartbeat({ idempotencyKey: "stable-heartbeat-key" });

    expect(requests).toEqual([
      {
        url: `http://relaymesh.test/api/v1/missions/${sessionIdentity.missionId}/sessions`,
        idempotencyKey: "stable-join-key",
      },
      {
        url: `http://relaymesh.test/api/v1/sessions/${sessionIdentity.id}/heartbeat`,
        idempotencyKey: "stable-heartbeat-key",
      },
    ]);
  });

  it("returns structured API failures", async () => {
    const fetcher: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "CONFLICT",
            message: "Idempotency key was already used",
            details: { operation: "task.claim" },
          },
        },
        409,
      );
    const agent = new RelayAgentClient("agent", "secret", { fetch: fetcher });

    const failure = expect(
      agent.join(
        "mission",
        {
          model: "model",
          role: "worker",
          capabilities: ["general"],
          recoveryFromSessionId: null,
        },
        { idempotencyKey: "collision" },
      ),
    ).rejects;
    await failure.toBeInstanceOf(RelayApiError);
    await failure.toEqual(
      expect.objectContaining<Partial<RelayApiError>>({
        name: "RelayApiError",
        status: 409,
        code: "CONFLICT",
        details: { operation: "task.claim" },
      }),
    );
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
