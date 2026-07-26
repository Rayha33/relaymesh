import { describe, expect, it } from "vitest";
import { planProductivityWorkflow } from "./workflow.js";

describe("productivity workflow planning", () => {
  it("gives every model independent work before a dependency-fed synthesis", () => {
    const tasks = planProductivityWorkflow({
      objective: "Build and verify a portable result.",
      contributorCount: 3,
      mode: "parallel",
    });
    expect(tasks).toHaveLength(4);
    expect(tasks.slice(0, 3).every((task) => task.dependencyKeys.length === 0))
      .toBe(true);
    expect(tasks[3]).toMatchObject({
      key: "final",
      dependencyKeys: [
        "contribution-1",
        "contribution-2",
        "contribution-3",
      ],
    });
    expect(tasks[3]?.description).toContain("dependencyOutputs");
  });

  it("keeps one-model and explicit single workflows lean", () => {
    expect(
      planProductivityWorkflow({
        objective: "Finish directly.",
        contributorCount: 5,
        mode: "single",
      }),
    ).toHaveLength(1);
    expect(
      planProductivityWorkflow({
        objective: "Finish directly.",
        contributorCount: 1,
        mode: "parallel",
      }),
    ).toHaveLength(1);
  });
});
