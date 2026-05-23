import { Liquid } from "liquidjs";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "./types";

export async function renderIssuePrompt(
  config: EffectiveWorkflowConfig,
  issue: NormalizedIssue,
  attempt: number | null
): Promise<string> {
  if (config.promptTemplate.trim().length === 0) {
    return `You are working on Linear issue ${issue.identifier}: ${issue.title}.`;
  }

  const engine = new Liquid({
    strictFilters: true,
    strictVariables: true
  });

  return engine.parseAndRender(config.promptTemplate, {
    issue,
    attempt
  });
}
