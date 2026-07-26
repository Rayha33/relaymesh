export type WorkflowMode = "parallel" | "single";

export interface WorkflowTaskPlan {
  key: string;
  title: string;
  description: string;
  priority: number;
  dependencyKeys: string[];
}

export function planProductivityWorkflow(input: {
  objective: string;
  contributorCount: number;
  mode: WorkflowMode;
}): WorkflowTaskPlan[] {
  if (!Number.isSafeInteger(input.contributorCount) || input.contributorCount < 1) {
    throw new Error("contributorCount must be a positive integer");
  }
  if (input.mode === "single" || input.contributorCount === 1) {
    return [
      {
        key: "final",
        title: "Produce the final deliverable",
        description: completionContract(input.objective),
        priority: 100,
        dependencyKeys: [],
      },
    ];
  }

  const contributionBriefs = [
    {
      title: "Produce the primary solution",
      focus:
        "Create the strongest concrete solution or deliverable. Make assumptions explicit and preserve actionable output.",
    },
    {
      title: "Challenge assumptions and failure modes",
      focus:
        "Work independently. Find missing requirements, incorrect assumptions, edge cases, safety issues, and simpler or stronger alternatives.",
    },
    {
      title: "Verify with evidence and tests",
      focus:
        "Independently test factual claims, logic, implementation quality, and completion criteria. Report failures precisely.",
    },
    {
      title: "Develop an alternative approach",
      focus:
        "Explore a meaningfully different solution and identify where it outperforms or loses to the obvious approach.",
    },
  ];
  const contributions = Array.from(
    { length: input.contributorCount },
    (_, index): WorkflowTaskPlan => {
      const brief = contributionBriefs[index] ?? {
        title: `Independent contribution ${index + 1}`,
        focus:
          "Contribute a self-contained analysis, implementation, or verification that reduces uncertainty or improves the final deliverable.",
      };
      return {
        key: `contribution-${index + 1}`,
        title: brief.title,
        description: [
          `Mission objective: ${input.objective}`,
          brief.focus,
          "Do not wait for another model or duplicate chat history. Checkpoint meaningful progress.",
          "Complete with a self-contained JSON result containing your concrete output, evidence, unresolved risks, and recommended next action.",
        ].join("\n\n"),
        priority: 100 - index,
        dependencyKeys: [],
      };
    },
  );

  return [
    ...contributions,
    {
      key: "final",
      title: "Synthesize and verify the final deliverable",
      description: [
        `Mission objective: ${input.objective}`,
        "The relay_sync work object contains dependencyOutputs from every parallel contribution. Reconcile them rather than repeating them.",
        "Resolve contradictions, retain the strongest evidence, close material gaps, and produce one coherent final deliverable.",
        "Complete with a JSON result containing: deliverable, evidence, decisions, limitations, and nextActions. The deliverable must be usable without reading the model chats.",
      ].join("\n\n"),
      priority: 100,
      dependencyKeys: contributions.map((task) => task.key),
    },
  ];
}

function completionContract(objective: string): string {
  return [
    `Mission objective: ${objective}`,
    "Produce the finished, usable deliverable rather than a progress update.",
    "Checkpoint meaningful progress and complete with a self-contained JSON result containing: deliverable, evidence, decisions, limitations, and nextActions.",
  ].join("\n\n");
}
