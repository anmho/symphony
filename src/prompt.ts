import { Liquid } from "liquidjs";
import { buildPrHandoffInstructions } from "./prHandoff.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "./types.js";

export async function renderIssuePrompt(
  config: EffectiveWorkflowConfig,
  issue: NormalizedIssue,
  attempt: number | null
): Promise<string> {
  if (config.promptTemplate.trim().length === 0) {
    return withPrHandoffInstructions(
      `You are working on Linear issue ${issue.identifier}: ${issue.title}.`,
      config,
      issue
    );
  }

  const engine = new Liquid({
    strictFilters: true,
    strictVariables: true
  });

  const rendered = await engine.parseAndRender(config.promptTemplate, {
    issue,
    attempt
  });
  return withPrHandoffInstructions(rendered, config, issue);
}

function withPrHandoffInstructions(
  prompt: string,
  config: EffectiveWorkflowConfig,
  issue: NormalizedIssue
): string {
  return `${prompt.trim()}\n\n${buildPrHandoffInstructions(config, issue)}`;
}
