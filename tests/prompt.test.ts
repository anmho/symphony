import { describe, expect, it } from "vitest";
import { renderIssuePrompt } from "../src/prompt.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "../src/types.js";

describe("prompt rendering", () => {
  it("renders Liquid issue fields", async () => {
    const config = {
      promptTemplate: "Implement {{ issue.identifier }}: {{ issue.title }} on attempt {{ attempt }}."
    } as EffectiveWorkflowConfig;
    const issue = {
      identifier: "APP-1",
      title: "Add checkout",
      id: "1",
      description: null,
      priority: null,
      state: "Todo",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null
    } satisfies NormalizedIssue;

    await expect(renderIssuePrompt(config, issue, 2)).resolves.toBe("Implement APP-1: Add checkout on attempt 2.");
  });
});
