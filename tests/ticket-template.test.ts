import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

  it("loads the bundled default template from built CLI output", async () => {
    execFileSync("bun", ["run", "build"], { stdio: "pipe" });

    const builtModuleUrl = pathToFileURL(`${process.cwd()}/dist/src/ticket-template.js`).href;
    const built = await import(`${builtModuleUrl}?test=${Date.now()}`);

    await expect(built.loadIssueTemplate()).resolves.toContain("## Context");
    expect(built.defaultIssueTemplatePath()).not.toContain("/dist/templates/");
  });
});
