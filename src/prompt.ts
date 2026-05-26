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
  return [
    prompt.trim(),
    buildRecentLinearComments(issue),
    buildPrHandoffInstructions(config, issue)
  ].filter(Boolean).join("\n\n");
}

function buildRecentLinearComments(issue: NormalizedIssue): string | null {
  const comments = issue.comments
    .map((comment) => comment.trim())
    .filter(Boolean)
    .slice(-5)
    .map((comment, index) => [`### Comment ${index + 1}`, truncateComment(comment)].join("\n\n"));

  if (comments.length === 0) {
    return null;
  }

  return ["## Recent Linear Comments", ...comments].join("\n\n");
}

function truncateComment(comment: string): string {
  const maxLength = 4000;
  if (comment.length <= maxLength) {
    return comment;
  }
  return `${comment.slice(0, maxLength).trimEnd()}\n\n[comment truncated]`;
}
