import { describe, expect, it } from "vitest";
import { renderIssuePrompt } from "../src/prompt.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "../src/types.js";

describe("prompt rendering", () => {
  it("renders Liquid issue fields", async () => {
    const config = {
      promptTemplate: "Implement {{ issue.identifier }}: {{ issue.title }} on attempt {{ attempt }}.",
      github: {
        prIdentity: null
      },
      pullRequest: {
        backend: "github",
        graphiteFallback: "fail"
      },
      digest: {
        enabled: false,
        recipient: "andyminhtuanho@gmail.com",
        sender: "Symphony <agent@anmho.com>",
        intervalMs: 3600000,
        windowMs: 3600000,
        resendApiKey: null,
        resendEndpoint: "https://api.resend.com/emails"
      }
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
      comments: [],
      attachments: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null
    } satisfies NormalizedIssue;

    const prompt = await renderIssuePrompt(config, issue, 2);
    expect(prompt).toContain("Implement APP-1: Add checkout on attempt 2.");
    expect(prompt).toContain("## PR Handoff Backend");
    expect(prompt).toContain("Use the default GitHub PR flow for handoff.");
  });
});
