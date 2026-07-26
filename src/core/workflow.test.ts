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

  it("forces council workflows through cross-examination before synthesis", () => {
    const tasks = planProductivityWorkflow({
      objective: "Reach a defensible decision.",
      contributorCount: 3,
      mode: "council",
    });
    expect(tasks).toHaveLength(5);
    expect(tasks[3]).toMatchObject({
      key: "convergence",
      title: "Cross-examine the council",
      dependencyKeys: [
        "contribution-1",
        "contribution-2",
        "contribution-3",
      ],
    });
    expect(tasks[3]?.description).toContain("disagreements");
    expect(tasks.every((task) => task.priority >= -100 && task.priority <= 100))
      .toBe(true);
    expect(tasks[4]).toMatchObject({
      key: "final",
      dependencyKeys: [
        "contribution-1",
        "contribution-2",
        "contribution-3",
        "convergence",
      ],
    });
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
