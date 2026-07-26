import { describe, expect, it, vi } from "vitest";
import type { RelaySessionClient } from "./client.js";
import {
  executeRelayFunction,
  relayFunctionTools,
} from "./tools.js";

describe("OpenAI-compatible RelayMesh tools", () => {
  it("publishes eleven strict, closed JSON schemas", () => {
    expect(relayFunctionTools).toHaveLength(11);
    expect(
      relayFunctionTools.map((tool) => tool.function.name),
    ).toEqual([
      "relay_sync",
      "relay_status",
      "relay_claim_task",
      "relay_checkpoint",
      "relay_complete_task",
      "relay_fail_task",
      "relay_handoff",
      "relay_send_message",
      "relay_inbox",
      "relay_acknowledge",
      "relay_publish_artifact",
    ]);
    for (const tool of relayFunctionTools) {
      expect(tool.function.strict).toBe(true);
      expect(tool.function.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("validates and dispatches function calls to the durable SDK", async () => {
    const complete = vi.fn(async () => ({ status: "completed" }));
    const session = {
      complete,
    } as unknown as RelaySessionClient;
    const taskId = "00000000-0000-4000-8000-000000000001";
    const leaseId = "00000000-0000-4000-8000-000000000002";

    await expect(
      executeRelayFunction(session, "relay_complete_task", {
        taskId,
        leaseId,
        fencingToken: 4,
        resultJson: JSON.stringify({ provider: "deepseek" }),
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(complete).toHaveBeenCalledWith(taskId, {
      leaseId,
      fencingToken: 4,
      result: { provider: "deepseek" },
    });

    await expect(
      executeRelayFunction(session, "relay_complete_task", {
        taskId: "not-a-uuid",
        leaseId,
        fencingToken: 4,
        resultJson: "{}",
      }),
    ).rejects.toThrow();
    await expect(
      executeRelayFunction(session, "unknown_tool", {}),
    ).rejects.toThrow("Unknown RelayMesh function tool");
  });
});
