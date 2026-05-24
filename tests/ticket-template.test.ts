import { describe, expect, it } from "vitest";
import { renderIssueTemplate } from "../src/ticket-template.js";

describe("ticket template", () => {
  it("renders placeholder sections", () => {
    const body = renderIssueTemplate(
      "## Context\n\n{{context}}\n\n## Problem\n\n{{problem}}",
      { context: "Background here" }
    );

    expect(body).toContain("Background here");
    expect(body).toContain("_TBD during triage/grill._");
    expect(body).not.toContain("{{context}}");
  });
});
